/**
 * OAuthHelper -- runs OAuth 2.0 authorization-code flows with PKCE for the
 * rest of the system, and keeps the tokens they produce fresh.
 *
 * Two kinds of caller:
 *
 * - `authorize(config)`: a provider the person registered an OAuth app with
 *   themselves (Google, GitHub, ...). Tokens land in SecretsVault, where a
 *   skill's `required-secret` binding picks them up.
 * - `authorizeMcp` / `mcpAccessToken`: an MCPBridge whose remote server
 *   answered 401. Everything comes from the server, as the MCP authorization
 *   spec lays out: its protected-resource metadata names the authorization
 *   server (RFC 9728), that server's metadata names the endpoints (RFC 8414),
 *   and dynamic client registration makes the client (RFC 7591). Tokens are
 *   bound to the server with the `resource` parameter (RFC 8707), refreshed
 *   here when they expire, and handed only to the built-in bridge of the
 *   skill they were granted for, and only for the address they were granted
 *   for.
 *
 * The flow:
 *   1. What needs no person happens first: discovery and a one-shot listener
 *      on 127.0.0.1.
 *   2. The person is asked, through DialogBroker, so the question reaches
 *      them wherever they are: a window on the desktop or the `abject`
 *      command in a terminal.
 *   3. Once they agree, the client is registered (when the server registers
 *      clients dynamically) and the sign-in page opens in a browser when this
 *      instance has a display, and a second dialog shows its address. The
 *      provider sends the browser back to the listener with a code; when the
 *      browser is on another device and cannot reach the listener, the person
 *      pastes the address it ended on into that dialog instead.
 *   4. The code is exchanged for tokens, which go to SecretsVault.
 *
 * No client IDs ship with the product: they come from the person's own
 * registration or from the server's dynamic registration.
 */

import * as http from 'http';
import { spawn } from 'child_process';
import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { require as contractRequire } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
import { bytesToBase64Url, randomToken } from '../core/encoding.js';

const log = new Log('OAuthHelper');

const OAUTH_HELPER_INTERFACE: InterfaceId = 'abjects:oauth-helper';
const ACCOUNTS_STORAGE_KEY = 'oauth:accounts';
/** How long the person has to approve, from when the sign-in page is shown. */
const FLOW_TIMEOUT_MS = 10 * 60 * 1000;
/** After an empty answer in the paste dialog, how long the browser still has to report back. */
const LATE_CALLBACK_MS = 60 * 1000;
/** An access token this close to expiry is refreshed before use. */
const EXPIRY_SKEW_MS = 60 * 1000;
/** The prefix of every MCPBridge's registered name; the rest is its skill. */
const MCP_BRIDGE_PREFIX = 'MCPBridge-';

export const OAUTH_HELPER_ID = 'abjects:oauth-helper' as AbjectId;

export interface OAuthProviderConfig {
  /** Stable identifier. Secrets land under `oauth:{provider}:access_token`, etc. */
  provider: string;
  /** Optional: display name of the account (e.g. the email). If userinfoEndpoint
   *  is set we'll try to fetch it; otherwise the caller can pass `accountLabel`. */
  accountLabel?: string;
  clientId: string;
  /** Some providers (GitHub web app) require a secret even with PKCE. */
  clientSecret?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Optional endpoint returning {email}/{name} so we can label the account. */
  userinfoEndpoint?: string;
  scopes: string[];
  /** Extra params to append to the authorize URL (e.g. `access_type=offline`). */
  extraAuthorizeParams?: Record<string, string>;
}

export interface ConnectedAccount {
  provider: string;
  account: string;
  scopes: string[];
  connectedAt: number;
  /** When the current access token expires, and when it was issued (ms since epoch). */
  expiresAt?: number;
  issuedAt?: number;
  /** Where and as whom the tokens are refreshed. */
  tokenEndpoint?: string;
  clientId?: string;
  /** The redirect address the client was registered with, reused when its port is free. */
  redirectUri?: string;
  /** An MCP grant: the server address it was made for, and the resource the tokens are bound to. */
  serverUrl?: string;
  resource?: string;
}

/** What a remote MCP server's metadata says about signing in to it. */
interface McpAuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  resource: string;
  scopes: string[];
}

/** One authorization-code flow, as `runFlow` is given it. */
interface FlowSpec {
  provider: string;
  /** The first question: may we sign in? */
  consent: { title: string; message: string };
  /** Who the sign-in page belongs to, for the second dialog. */
  host: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** The client to sign in as, given the redirect address it must accept. */
  client: (redirectUri: string) => Promise<{ clientId: string; clientSecret?: string }>;
  scopes: string[];
  resource?: string;
  extraAuthorizeParams?: Record<string, string>;
  /** A redirect address used before; its port is tried first so the client can be reused. */
  preferredRedirectUri?: string;
}

interface FlowResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

/** Thrown when the person says no; the caller reports it as a decline, not a fault. */
class SignInDeclined extends Error {}

export class OAuthHelper extends Abject {
  private httpClientId?: AbjectId;
  private secretsVaultId?: AbjectId;
  private storageId?: AbjectId;
  private accounts = new Map<string, ConnectedAccount>();
  /** One flow per provider at a time; a second caller shares the first one's outcome. */
  private flows = new Map<string, Promise<ConnectedAccount>>();
  /** One refresh per provider at a time: refresh tokens rotate, so two would race. */
  private refreshes = new Map<string, Promise<boolean>>();

  constructor() {
    super({
      manifest: {
        name: 'OAuthHelper',
        description:
          'Runs OAuth 2.0 + PKCE sign-ins: asks the person, opens the sign-in page, ' +
          'captures the approval on a one-shot localhost listener (or a pasted address), ' +
          'and stores the tokens in SecretsVault. Signs MCP bridges in to remote MCP ' +
          'servers using the servers\' own metadata and dynamic client registration, ' +
          'and refreshes those tokens. No client IDs ship with the product.',
        version: '1.1.0',
        interface: {
          id: OAUTH_HELPER_INTERFACE,
          name: 'OAuthHelper',
          description: 'Interactive OAuth flows',
          methods: [
            {
              name: 'authorize',
              description: 'Start an OAuth authorization flow with a client the person registered. Asks the person, opens the sign-in page, and waits for approval.',
              parameters: [
                { name: 'config', type: { kind: 'reference', reference: 'OAuthProviderConfig' }, description: 'Provider configuration' },
              ],
              returns: { kind: 'reference', reference: 'ConnectedAccount' },
            },
            {
              name: 'authorizeMcp',
              description: 'Sign an MCP bridge in to its remote server, discovering everything from the server. Only the built-in MCPBridge of the named skill may call this.',
              parameters: [
                { name: 'provider', type: { kind: 'primitive', primitive: 'string' }, description: '"mcp:<skill>"' },
                { name: 'serverUrl', type: { kind: 'primitive', primitive: 'string' }, description: 'The MCP endpoint' },
                { name: 'challenge', type: { kind: 'primitive', primitive: 'string' }, description: 'The server\'s WWW-Authenticate header', optional: true },
                { name: 'clientId', type: { kind: 'primitive', primitive: 'string' }, description: 'A pre-registered client id, for a server without dynamic registration', optional: true },
              ],
              returns: { kind: 'reference', reference: 'ConnectedAccount' },
            },
            {
              name: 'mcpAccessToken',
              description: 'A current access token for an MCP grant, refreshed when needed. Returns {} when there is no usable grant. Only the built-in MCPBridge of the named skill may call this.',
              parameters: [
                { name: 'provider', type: { kind: 'primitive', primitive: 'string' }, description: '"mcp:<skill>"' },
                { name: 'serverUrl', type: { kind: 'primitive', primitive: 'string' }, description: 'The MCP endpoint the token is for' },
                { name: 'forceRefresh', type: { kind: 'primitive', primitive: 'boolean' }, description: 'The server refused the current token', optional: true },
              ],
              returns: { kind: 'object', properties: {
                token: { kind: 'primitive', primitive: 'string' },
                expiresAt: { kind: 'primitive', primitive: 'number' },
              } },
            },
            {
              name: 'disconnect',
              description: 'Remove a connected account and forget its tokens.',
              parameters: [
                { name: 'provider', type: { kind: 'primitive', primitive: 'string' }, description: 'Provider id' },
              ],
              returns: { kind: 'object', properties: { disconnected: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'listConnected',
              description: 'List all currently connected accounts (metadata only).',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'reference', reference: 'ConnectedAccount' } },
            },
          ],
        },
        tags: ['system', 'auth', 'oauth'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.httpClientId = await this.discoverDep('HttpClient') ?? undefined;
    this.secretsVaultId = await this.discoverDep('SecretsVault') ?? undefined;
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    await this.loadAccounts();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## OAuthHelper Usage Guide

Runs OAuth 2.0 + PKCE sign-ins. The person is asked first, through a dialog
that reaches them on the desktop or in the \`abject\` terminal; then the
sign-in page opens and the approval comes back on its own.

### Connect a provider with your own OAuth client

The person supplies their own OAuth client credentials; no secrets ship with
Abjects.

  const account = await call(await dep('OAuthHelper'), 'authorize', {
    config: {
      provider: 'google',
      clientId: '<user-registered-client-id>',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      userinfoEndpoint: 'https://www.googleapis.com/oauth2/v2/userinfo',
      scopes: ['openid', 'email', 'profile'],
      extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
    },
  });
  // account: { provider, account, scopes, connectedAt, expiresAt? }

### Remote MCP servers

Nothing to call: a remote MCP skill (\`mcp-url\` in its SKILL.md) signs in by
itself. When its server answers 401, the skill's MCPBridge asks this object to
sign in, using the server's own OAuth metadata and dynamic client
registration, and the person approves in their browser. Only that bridge can
read the tokens.

### List connected accounts

  const accounts = await call(await dep('OAuthHelper'), 'listConnected', {});

### Disconnect

  await call(await dep('OAuthHelper'), 'disconnect', { provider: 'google' });

### Token storage

Tokens land in SecretsVault under:
  - oauth:{provider}:access_token
  - oauth:{provider}:refresh_token (if provider issues one)

Skills can pull them via SecretsVault.bindEnv mappings.

### IMPORTANT
- The interface ID is '${OAUTH_HELPER_INTERFACE}'.
- The person has ${FLOW_TIMEOUT_MS / 60000} minutes to approve once the sign-in page is shown.
- PKCE is always used; clientSecret only sent if the config includes one.`;
  }

  // ─── Handlers ───────────────────────────────────────────────────

  private setupHandlers(): void {
    this.on('authorize', async (msg: AbjectMessage) => {
      const { config } = msg.payload as { config: OAuthProviderConfig };
      validateConfig(config);
      return this.once(config.provider, () => this.authorize(config));
    });

    this.on('authorizeMcp', async (msg: AbjectMessage) => {
      const { provider, serverUrl, challenge, clientId } = msg.payload as {
        provider: string; serverUrl: string; challenge?: string; clientId?: string;
      };
      contractRequire(typeof serverUrl === 'string' && /^https?:\/\//i.test(serverUrl), 'serverUrl must be http(s)');
      await this.admitBridge(msg.routing.from, provider);
      return this.once(provider, () => this.authorizeMcp(provider, serverUrl, challenge, clientId));
    });

    this.on('mcpAccessToken', async (msg: AbjectMessage) => {
      const { provider, serverUrl, forceRefresh } = msg.payload as {
        provider: string; serverUrl: string; forceRefresh?: boolean;
      };
      contractRequire(typeof serverUrl === 'string' && serverUrl.length > 0, 'serverUrl must be non-empty');
      await this.admitBridge(msg.routing.from, provider);
      return this.mcpAccessToken(provider, serverUrl, forceRefresh === true);
    });

    this.on('disconnect', async (msg: AbjectMessage) => {
      const { provider } = msg.payload as { provider: string };
      contractRequire(typeof provider === 'string' && provider.length > 0, 'provider must be non-empty');
      return this.disconnect(provider);
    });

    this.on('listConnected', async () => {
      return [...this.accounts.values()];
    });
  }

  /**
   * MCP tokens go only to the built-in bridge of the skill they belong to:
   * `MCPBridge-<skill>` for provider `mcp:<skill>`. A registered name proves
   * nothing alone, so the registration must also be built-in.
   */
  private async admitBridge(callerId: AbjectId, provider: string): Promise<void> {
    contractRequire(typeof provider === 'string' && provider.startsWith('mcp:'), 'provider must be "mcp:<skill>"');
    const caller = await this.resolveCallerIdentity(callerId);
    const skill = caller?.name.startsWith(MCP_BRIDGE_PREFIX) ? caller.name.slice(MCP_BRIDGE_PREFIX.length) : undefined;
    if (!caller?.builtIn || provider !== `mcp:${skill}`) {
      throw new Error(`Only the MCP bridge of "${provider.slice(4)}" may use its sign-in`);
    }
  }

  /** Run `start` unless a flow for this provider is already under way, and share its outcome. */
  private once(provider: string, start: () => Promise<ConnectedAccount>): Promise<ConnectedAccount> {
    const running = this.flows.get(provider);
    if (running) return running;
    const flow = start().finally(() => this.flows.delete(provider));
    this.flows.set(provider, flow);
    return flow;
  }

  // ─── Providers the person registered ────────────────────────────

  private async authorize(config: OAuthProviderConfig): Promise<ConnectedAccount> {
    const host = hostOf(config.authorizationEndpoint);
    const result = await this.runFlow({
      provider: config.provider,
      consent: {
        title: `Sign in to ${config.provider}`,
        message: `Connect your ${config.provider} account? The sign-in page at ${host} opens next, and you approve access there.`,
      },
      host,
      authorizationEndpoint: config.authorizationEndpoint,
      tokenEndpoint: config.tokenEndpoint,
      client: async () => ({ clientId: config.clientId, clientSecret: config.clientSecret }),
      scopes: config.scopes,
      extraAuthorizeParams: config.extraAuthorizeParams,
    });

    const label = await this.accountLabel(config, result.accessToken);
    return this.connect({
      provider: config.provider,
      account: label,
      scopes: config.scopes,
      connectedAt: Date.now(),
      tokenEndpoint: config.tokenEndpoint,
      clientId: result.clientId,
    }, result);
  }

  private async accountLabel(config: OAuthProviderConfig, accessToken: string): Promise<string> {
    const fallback = config.accountLabel ?? config.provider;
    if (!config.userinfoEndpoint) return fallback;
    try {
      const info = await this.http({
        method: 'GET',
        url: config.userinfoEndpoint,
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
      });
      if (!info.ok) return fallback;
      const parsed = JSON.parse(info.body) as Record<string, unknown>;
      return typeof parsed.email === 'string' ? parsed.email
        : typeof parsed.login === 'string' ? parsed.login
        : typeof parsed.name === 'string' ? parsed.name
        : fallback;
    } catch {
      return fallback;
    }
  }

  // ─── Remote MCP servers ─────────────────────────────────────────

  private async authorizeMcp(
    provider: string, serverUrl: string, challenge: string | undefined, clientId: string | undefined,
  ): Promise<ConnectedAccount> {
    const skill = provider.slice('mcp:'.length);
    const server = await this.discoverMcpAuth(serverUrl, challenge);
    const host = hostOf(serverUrl);
    const previous = this.accounts.get(provider);
    // A client registered for this same authorization server can be used
    // again when its redirect address is free; otherwise register anew.
    const reusable = previous?.clientId && previous.tokenEndpoint === server.tokenEndpoint && previous.redirectUri
      ? { clientId: previous.clientId, redirectUri: previous.redirectUri }
      : undefined;

    const result = await this.runFlow({
      provider,
      consent: {
        title: `Sign in to ${host}`,
        message: `The "${skill}" skill connects to the MCP server at ${serverUrl}, which asks you to sign in ` +
          `and approve access. Sign in now? The sign-in page at ${hostOf(server.authorizationEndpoint)} opens next.`,
      },
      host: hostOf(server.authorizationEndpoint),
      authorizationEndpoint: server.authorizationEndpoint,
      tokenEndpoint: server.tokenEndpoint,
      client: async (redirectUri) => {
        if (clientId) return { clientId, clientSecret: await this.secret(`oauth:${provider}:client_secret`) };
        if (reusable && reusable.redirectUri === redirectUri) {
          return { clientId: reusable.clientId, clientSecret: await this.secret(`oauth:${provider}:client_secret`) };
        }
        if (!server.registrationEndpoint) {
          throw new Error(
            `${server.issuer} offers no client registration, so a client must be registered with it by hand. ` +
            `Put its client id in the skill's SKILL.md as mcp-oauth-client-id.`);
        }
        return this.registerClient(server.registrationEndpoint, redirectUri, server.scopes);
      },
      scopes: server.scopes,
      resource: server.resource,
      preferredRedirectUri: reusable?.redirectUri,
    });

    return this.connect({
      provider,
      account: host,
      scopes: server.scopes,
      connectedAt: Date.now(),
      tokenEndpoint: server.tokenEndpoint,
      clientId: result.clientId,
      redirectUri: result.redirectUri,
      serverUrl,
      resource: server.resource,
    }, result);
  }

  /**
   * A token for an MCP grant: the stored one while it is fresh, a refreshed
   * one when it is not (or when the server just refused it), and nothing when
   * there is no grant for this address or the refresh no longer works.
   */
  private async mcpAccessToken(
    provider: string, serverUrl: string, forceRefresh: boolean,
  ): Promise<{ token?: string; expiresAt?: number }> {
    const account = this.accounts.get(provider);
    // Tokens granted for one address never go to another, even under the
    // same skill name: the skill may have been pointed somewhere else since.
    if (!account || account.serverUrl !== serverUrl) return {};
    if (!forceRefresh && stillFresh(account)) {
      const token = await this.secret(`oauth:${provider}:access_token`);
      if (token) return { token, expiresAt: account.expiresAt };
    }
    if (!(await this.refresh(provider))) return {};
    const token = await this.secret(`oauth:${provider}:access_token`);
    return token ? { token, expiresAt: this.accounts.get(provider)?.expiresAt } : {};
  }

  /**
   * Find out how to sign in to an MCP server. The server's 401 points at its
   * protected-resource metadata (or it sits at the well-known address), which
   * names the authorization server; that server's metadata names the
   * endpoints. A server that publishes neither is treated the way the
   * 2025-03-26 spec treated it: its own origin is the authorization server,
   * with the default endpoint paths.
   */
  private async discoverMcpAuth(serverUrl: string, challenge: string | undefined): Promise<McpAuthServer> {
    const params = parseChallenge(challenge);
    const failures: string[] = [];
    const server = new URL(serverUrl);

    let prm: Record<string, unknown> | undefined;
    const prmCandidates = params.resource_metadata
      ? [params.resource_metadata]
      : wellKnownCandidates(serverUrl, 'oauth-protected-resource');
    for (const candidate of prmCandidates) {
      prm = await this.getJson(candidate, failures);
      if (prm) break;
    }

    let resource = canonicalResource(serverUrl);
    if (typeof prm?.resource === 'string') {
      // Metadata may describe only the server it was fetched for.
      if (new URL(prm.resource).origin !== server.origin) {
        throw new Error(`${server.host} published resource metadata for another origin (${prm.resource})`);
      }
      resource = prm.resource;
    }
    const issuers = Array.isArray(prm?.authorization_servers)
      ? (prm!.authorization_servers as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];
    const issuer = issuers[0] ?? server.origin;

    let meta: Record<string, unknown> | undefined;
    for (const candidate of authServerMetadataCandidates(issuer)) {
      const found = await this.getJson(candidate, failures);
      if (found && typeof found.authorization_endpoint === 'string' && typeof found.token_endpoint === 'string') {
        meta = found;
        break;
      }
    }
    if (!meta && prm) {
      throw new Error(`${issuer} publishes no authorization server metadata (${failures.join('; ') || 'nothing found'})`);
    }
    const origin = new URL(issuer).origin;
    const authorizationEndpoint = (meta?.authorization_endpoint as string | undefined) ?? `${origin}/authorize`;
    const tokenEndpoint = (meta?.token_endpoint as string | undefined) ?? `${origin}/token`;
    const registrationEndpoint = meta
      ? (typeof meta.registration_endpoint === 'string' ? meta.registration_endpoint : undefined)
      : `${origin}/register`;

    // PKCE with S256 is not optional; a server that says it lacks it is refused.
    const methods = meta?.code_challenge_methods_supported;
    if (Array.isArray(methods) && !methods.includes('S256')) {
      throw new Error(`${issuer} does not support PKCE with S256, which signing in requires`);
    }

    const scopes = params.scope
      ? params.scope.split(/\s+/).filter(Boolean)
      : Array.isArray(prm?.scopes_supported)
        ? (prm!.scopes_supported as unknown[]).filter((s): s is string => typeof s === 'string')
        : [];

    log.info(`MCP sign-in for ${serverUrl}: issuer=${issuer} registration=${registrationEndpoint ? 'yes' : 'no'} scopes=${scopes.join(' ') || '(none)'}`);
    return { issuer, authorizationEndpoint, tokenEndpoint, registrationEndpoint, resource, scopes };
  }

  /** Dynamic client registration (RFC 7591) as a public client using PKCE. */
  private async registerClient(
    registrationEndpoint: string, redirectUri: string, scopes: string[],
  ): Promise<{ clientId: string; clientSecret?: string }> {
    const res = await this.http({
      method: 'POST',
      url: registrationEndpoint,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        client_name: 'Abjects',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(scopes.length > 0 ? { scope: scopes.join(' ') } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`Client registration at ${registrationEndpoint} failed (HTTP ${res.status}): ${res.body.slice(0, 200)}`);
    }
    const body = parseJsonObject(res.body);
    const clientId = typeof body?.client_id === 'string' ? body.client_id : undefined;
    if (!clientId) throw new Error(`Client registration at ${registrationEndpoint} returned no client_id`);
    return { clientId, clientSecret: typeof body?.client_secret === 'string' ? body.client_secret : undefined };
  }

  // ─── The flow ───────────────────────────────────────────────────

  private async runFlow(spec: FlowSpec): Promise<FlowResult> {
    const verifier = randomToken(64);
    const challenge = await sha256Base64Url(verifier);
    const state = randomToken(24);

    // The callback lands here; created first so the redirect address (its
    // port) is known to client registration.
    let settle: (outcome: { code: string } | { error: Error }) => void = () => {};
    const outcome = new Promise<{ code: string } | { error: Error }>((resolve) => { settle = resolve; });
    const preferredPort = spec.preferredRedirectUri ? Number(new URL(spec.preferredRedirectUri).port) : 0;
    const { server, port } = await listenLoopback(preferredPort, (req, res) => handleCallback(req, res, state, settle));
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const withdraw = new AbortController();
    try {
      const agreed = await this.confirm({
        title: spec.consent.title,
        message: spec.consent.message,
        confirmLabel: 'Sign in',
        cancelLabel: 'Not now',
      });
      if (!agreed) throw new SignInDeclined('The person chose not to sign in');

      // Registered only once the person has agreed, so a declined sign-in
      // leaves nothing behind on the server.
      const client = await spec.client(redirectUri);

      const params = new URLSearchParams();
      params.set('response_type', 'code');
      params.set('client_id', client.clientId);
      params.set('redirect_uri', redirectUri);
      if (spec.scopes.length > 0) params.set('scope', spec.scopes.join(' '));
      params.set('state', state);
      params.set('code_challenge', challenge);
      params.set('code_challenge_method', 'S256');
      if (spec.resource) params.set('resource', spec.resource);
      for (const [k, v] of Object.entries(spec.extraAuthorizeParams ?? {})) params.set(k, v);
      const authUrl = `${spec.authorizationEndpoint}?${params.toString()}`;

      timer = setTimeout(() => settle({ error: new Error('Nobody approved the sign-in in time') }), FLOW_TIMEOUT_MS);
      const opened = await this.openForPerson(authUrl);
      log.info(`Sign-in for ${spec.provider} waiting on ${spec.host}${opened ? ' (page opened)' : ''}`);

      // The second dialog: where to approve, and the way back when the
      // browser cannot reach this machine. The browser finishing first
      // withdraws it.
      this.prompt({
        title: `Approve access at ${spec.host}`,
        message:
          (opened
            ? 'The sign-in page has opened. Approve access there; this closes by itself once you do.'
            : 'Open the sign-in page below and approve access there; this closes by itself once you do.') +
          `\n\nSign-in page:\n${authUrl}\n\n` +
          'If your browser is on another device, the page it lands on after you approve will not load. ' +
          'Copy that page\'s address and paste it here.',
        placeholder: 'http://127.0.0.1:…/callback?code=…',
        confirmLabel: 'Use this address',
        cancelLabel: 'Cancel sign-in',
        signal: withdraw.signal,
      }).then((answer) => {
        if (withdraw.signal.aborted) return;
        if (answer === null) {
          settle({ error: new SignInDeclined('The person cancelled the sign-in') });
          return;
        }
        const code = codeFromPaste(answer, state);
        if (code) {
          settle({ code });
          return;
        }
        // Answered with nothing: the browser may still be on its way back.
        clearTimeout(timer);
        timer = setTimeout(() => settle({ error: new Error('No approval arrived from the browser') }), LATE_CALLBACK_MS);
      }).catch((err) => settle({ error: err instanceof Error ? err : new Error(String(err)) }));

      const result = await outcome;
      if ('error' in result) throw result.error;

      const tokens = await this.exchange(spec.tokenEndpoint, {
        grant_type: 'authorization_code',
        code: result.code,
        redirect_uri: redirectUri,
        client_id: client.clientId,
        code_verifier: verifier,
        ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
        ...(spec.resource ? { resource: spec.resource } : {}),
      });
      return { ...tokens, clientId: client.clientId, clientSecret: client.clientSecret, redirectUri };
    } finally {
      clearTimeout(timer);
      withdraw.abort();
      try { server.close(); } catch { /* already closing */ }
    }
  }

  /** Open the sign-in page in the person's browser, when there is a browser to open. */
  private async openForPerson(url: string): Promise<boolean> {
    const display = await this.hasDisplay();
    // Headless: there is no browser here; the dialog in the terminal carries the address.
    if (!display) return false;
    // Inside the desktop app the person sits at this machine, and their own
    // browser (with their sessions) is the one to use.
    if (process.versions.electron) {
      return openBrowser(url).then(() => true, (err) => {
        log.warn(`Could not open a browser: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      });
    }
    // A browser client: open it there, wherever the person is.
    const widgetManagerId = await this.discoverDep('WidgetManager');
    if (!widgetManagerId || !(await this.isBuiltInCaller(widgetManagerId, ['WidgetManager']))) return false;
    try {
      return await this.request<boolean>(request(this.id, widgetManagerId, 'openUrl', { url }), 5000) === true;
    } catch {
      return false;
    }
  }

  private async hasDisplay(): Promise<boolean> {
    const infoId = await this.discoverDep('InstanceInfo');
    if (!infoId) return false;
    try {
      const info = await this.request<{ display?: boolean }>(request(this.id, infoId, 'getInfo', {}), 5000);
      return info?.display === true;
    } catch {
      return false;
    }
  }

  // ─── Tokens ─────────────────────────────────────────────────────

  /** POST a token request and read the tokens out of the answer. */
  private async exchange(
    tokenEndpoint: string, form: Record<string, string>,
  ): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
    const res = await this.http({
      method: 'POST',
      url: tokenEndpoint,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
    if (!res.ok) throw new Error(`Token endpoint ${res.status}: ${res.body.slice(0, 200)}`);
    const tokens = parseJsonObject(res.body);
    if (!tokens) throw new Error('Token endpoint returned non-JSON');
    const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : undefined;
    if (!accessToken) throw new Error('Token response missing access_token');
    const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : undefined;
    return {
      accessToken,
      refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
    };
  }

  /** Use the refresh token, once at a time per provider. True when a new access token is stored. */
  private refresh(provider: string): Promise<boolean> {
    const running = this.refreshes.get(provider);
    if (running) return running;
    const attempt = this.doRefresh(provider).finally(() => this.refreshes.delete(provider));
    this.refreshes.set(provider, attempt);
    return attempt;
  }

  private async doRefresh(provider: string): Promise<boolean> {
    const account = this.accounts.get(provider);
    if (!account?.tokenEndpoint || !account.clientId) return false;
    const refreshToken = await this.secret(`oauth:${provider}:refresh_token`);
    if (!refreshToken) return false;
    const clientSecret = await this.secret(`oauth:${provider}:client_secret`);
    try {
      const tokens = await this.exchange(account.tokenEndpoint, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: account.clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        ...(account.resource ? { resource: account.resource } : {}),
      });
      await this.storeToken(provider, 'access_token', tokens.accessToken, tokens.expiresAt);
      // Refresh tokens may rotate: the old one is spent once a new one comes back.
      if (tokens.refreshToken) await this.storeToken(provider, 'refresh_token', tokens.refreshToken);
      this.accounts.set(provider, { ...account, expiresAt: tokens.expiresAt, issuedAt: Date.now() });
      await this.persistAccounts();
      log.info(`Refreshed ${provider}`);
      return true;
    } catch (err) {
      // A refused refresh token will not work next time either; dropping it
      // makes the next use go straight to signing in again.
      log.warn(`Refresh for ${provider} failed: ${err instanceof Error ? err.message : String(err)}`);
      await this.forgetSecret(`oauth:${provider}:refresh_token`);
      await this.forgetSecret(`oauth:${provider}:access_token`);
      return false;
    }
  }

  /** Store a finished flow's tokens and record the account. */
  private async connect(account: ConnectedAccount, result: FlowResult): Promise<ConnectedAccount> {
    const { provider } = account;
    await this.storeToken(provider, 'access_token', result.accessToken, result.expiresAt);
    if (result.refreshToken) await this.storeToken(provider, 'refresh_token', result.refreshToken);
    else await this.forgetSecret(`oauth:${provider}:refresh_token`);
    if (result.clientSecret) await this.storeToken(provider, 'client_secret', result.clientSecret);
    else await this.forgetSecret(`oauth:${provider}:client_secret`);

    const connected: ConnectedAccount = { ...account, expiresAt: result.expiresAt, issuedAt: Date.now() };
    this.accounts.set(provider, connected);
    await this.persistAccounts();
    this.changed('accountsChanged', { reason: 'connected', provider });
    log.info(`Connected ${provider} as ${connected.account}`);
    return connected;
  }

  private async storeToken(
    provider: string, kind: 'access_token' | 'refresh_token' | 'client_secret', value: string, expiresAt?: number,
  ): Promise<void> {
    if (!this.secretsVaultId) {
      log.warn('SecretsVault not available; dropping token');
      return;
    }
    await this.request(
      request(this.id, this.secretsVaultId, 'store', {
        name: `oauth:${provider}:${kind}`,
        value,
        meta: {
          owner: `oauth:${provider}`,
          description: `${provider} ${kind.replace('_', ' ')}`,
          scope: 'global',
          expiresAt,
        },
      }),
    );
  }

  /** A stored secret's value, or undefined when there is none. */
  private async secret(name: string): Promise<string | undefined> {
    if (!this.secretsVaultId) return undefined;
    try {
      const { exists } = await this.request<{ exists: boolean }>(
        request(this.id, this.secretsVaultId, 'exists', { name }),
      );
      if (!exists) return undefined;
      const { value } = await this.request<{ value: string }>(
        request(this.id, this.secretsVaultId, 'reveal', { name }),
      );
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  private async forgetSecret(name: string): Promise<void> {
    if (!this.secretsVaultId) return;
    try {
      await this.request(request(this.id, this.secretsVaultId, 'forget', { name }));
    } catch { /* best effort */ }
  }

  private async disconnect(provider: string): Promise<{ disconnected: boolean }> {
    if (!this.accounts.has(provider)) return { disconnected: false };
    this.accounts.delete(provider);
    await this.persistAccounts();
    for (const kind of ['access_token', 'refresh_token', 'client_secret'] as const) {
      await this.forgetSecret(`oauth:${provider}:${kind}`);
    }
    this.changed('accountsChanged', { reason: 'disconnected', provider });
    log.info(`Disconnected ${provider}`);
    return { disconnected: true };
  }

  // ─── HTTP ───────────────────────────────────────────────────────

  private async http(req: {
    method: 'GET' | 'POST'; url: string; headers?: Record<string, string>; body?: string;
  }): Promise<{ ok: boolean; status: number; body: string }> {
    contractRequire(this.httpClientId !== undefined, 'HttpClient not available');
    return this.request(request(this.id, this.httpClientId!, 'request', { ...req, timeout: 20000 }), 30000);
  }

  /** A JSON object from `url`, or undefined (with the reason added to `failures`). */
  private async getJson(url: string, failures: string[]): Promise<Record<string, unknown> | undefined> {
    try {
      const res = await this.http({ method: 'GET', url, headers: { 'Accept': 'application/json' } });
      if (!res.ok) {
        failures.push(`${url}: HTTP ${res.status}`);
        return undefined;
      }
      const body = parseJsonObject(res.body);
      if (!body) failures.push(`${url}: not JSON`);
      return body;
    } catch (err) {
      failures.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  // ─── Storage ────────────────────────────────────────────────────

  private async loadAccounts(): Promise<void> {
    if (!this.storageId) return;
    try {
      const raw = await this.request<unknown>(
        request(this.id, this.storageId, 'get', { key: ACCOUNTS_STORAGE_KEY }),
      );
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (!item || typeof item !== 'object') continue;
          const a = item as ConnectedAccount;
          if (typeof a.provider === 'string' && typeof a.account === 'string') {
            this.accounts.set(a.provider, a);
          }
        }
      }
    } catch { /* not available */ }
  }

  private async persistAccounts(): Promise<void> {
    if (!this.storageId) return;
    const list = [...this.accounts.values()];
    try {
      await this.request(
        request(this.id, this.storageId, 'set', { key: ACCOUNTS_STORAGE_KEY, value: list }),
      );
    } catch { /* best effort */ }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function validateConfig(config: OAuthProviderConfig): void {
  contractRequire(typeof config === 'object' && config !== null, 'config must be an object');
  contractRequire(typeof config.provider === 'string' && config.provider.length > 0, 'provider required');
  contractRequire(!config.provider.startsWith('mcp:'), 'mcp: providers belong to MCP bridges');
  contractRequire(typeof config.clientId === 'string' && config.clientId.length > 0, 'clientId required');
  contractRequire(typeof config.authorizationEndpoint === 'string' && /^https?:\/\//.test(config.authorizationEndpoint), 'authorizationEndpoint must be http(s)');
  contractRequire(typeof config.tokenEndpoint === 'string' && /^https?:\/\//.test(config.tokenEndpoint), 'tokenEndpoint must be http(s)');
  contractRequire(Array.isArray(config.scopes) && config.scopes.every(s => typeof s === 'string'), 'scopes must be string[]');
}

/**
 * Whether an account's access token is good to hand out: it is refreshed a
 * little before it expires, a minute early, or a quarter of its life early
 * for a token that lives only minutes.
 */
function stillFresh(account: ConnectedAccount): boolean {
  if (!account.expiresAt) return true;
  const lifetime = account.issuedAt ? account.expiresAt - account.issuedAt : Infinity;
  return account.expiresAt - Date.now() > Math.min(EXPIRY_SKEW_MS, lifetime / 4);
}

/** The parameters of a `Bearer` WWW-Authenticate challenge. */
function parseChallenge(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  const re = /([a-zA-Z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    out[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
  }
  return out;
}

/** Where RFC 9728 metadata may sit for a server: under its path first, then at the root. */
function wellKnownCandidates(serverUrl: string, name: string): string[] {
  const url = new URL(serverUrl);
  const path = url.pathname.replace(/\/+$/, '');
  const root = `${url.origin}/.well-known/${name}`;
  return path ? [`${root}${path}`, root] : [root];
}

/** Where an authorization server's metadata may sit (RFC 8414, then OpenID discovery). */
function authServerMetadataCandidates(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, '');
  if (!path) {
    return [
      `${url.origin}/.well-known/oauth-authorization-server`,
      `${url.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

/** The server's address as an RFC 8707 resource: no fragment, lowercase scheme and host. */
function canonicalResource(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = '';
  return url.toString();
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The code in what the person pasted: the address the browser landed on
 * (whose state must be this flow's), or a bare code. Undefined for an empty
 * answer.
 */
function codeFromPaste(text: string, state: string): string | undefined {
  const pasted = text.trim();
  if (!pasted) return undefined;
  let url: URL | undefined;
  try { url = new URL(pasted); } catch { /* not an address */ }
  if (!url) {
    if (/^[\w.~-]{8,}$/.test(pasted)) return pasted;
    throw new Error('That is not the address the browser landed on');
  }
  const error = url.searchParams.get('error');
  if (error) throw new Error(`Sign-in refused: ${error} ${url.searchParams.get('error_description') ?? ''}`.trim());
  if (url.searchParams.get('state') !== state) throw new Error('That address belongs to a different sign-in');
  const code = url.searchParams.get('code');
  if (!code) throw new Error('That address carries no approval code');
  return code;
}

async function sha256Base64Url(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
  return bytesToBase64Url(hash);
}

/** The browser coming back with a code (or an error) for the flow with this state. */
function handleCallback(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  expectedState: string,
  settle: (outcome: { code: string } | { error: Error }) => void,
): void {
  const fullUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (!fullUrl.pathname.startsWith('/callback')) {
    res.statusCode = 404;
    res.end('Not Found');
    return;
  }
  const params = fullUrl.searchParams;
  if (params.get('state') !== expectedState) {
    res.statusCode = 400;
    res.end('Invalid state');
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const error = params.get('error');
  if (error) {
    const description = params.get('error_description') ?? '';
    res.statusCode = 400;
    res.end(html(`<h1>Sign-in refused</h1><p>${escapeHtml(error)}: ${escapeHtml(description)}</p>`));
    settle({ error: new Error(`OAuth error: ${error} (${description})`) });
    return;
  }
  const code = params.get('code');
  if (!code) {
    res.statusCode = 400;
    res.end('Missing code');
    return;
  }
  res.statusCode = 200;
  res.end(html('<h1>Approved</h1><p>You can close this tab and return to Abjects.</p>'));
  settle({ code });
}

/** A one-shot listener on 127.0.0.1, on `preferredPort` when it is free. */
async function listenLoopback(
  preferredPort: number,
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; port: number }> {
  const listen = (port: number) => new Promise<{ server: http.Server; port: number }>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try { handler(req, res); } catch (err) {
        log.warn(`Callback handler threw: ${err instanceof Error ? err.message : String(err)}`);
        try { res.statusCode = 500; res.end('Internal error'); } catch { /* socket gone */ }
      }
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve({ server, port: addr.port });
      else reject(new Error('Failed to bind listener'));
    });
  });
  if (preferredPort > 0) {
    try { return await listen(preferredPort); } catch { /* taken; any port will do */ }
  }
  return listen(0);
}

function openBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    // Windows opens it without a shell: through cmd's `start`, the `&` between
    // query parameters would end the command.
    const [cmd, args] = platform === 'darwin' ? ['open', [url]]
      : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function html(body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Sign-in</title>
<style>body{font:14px/1.5 system-ui,sans-serif;padding:40px;max-width:540px;margin:0 auto}h1{font-size:18px}p{color:#555}</style>
${body}`;
}
