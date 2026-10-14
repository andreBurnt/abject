/**
 * Shared type definitions for the Skill system.
 *
 * Skills are SKILL.md files (YAML frontmatter + markdown instructions) installed
 * in $ABJECTS_DATA_DIR/skills/. They are compatible with Claude Code and OpenClaw formats.
 */

/** Information about a discovered skill. */
export interface SkillInfo {
  name: string;
  description: string;
  version?: string;
  source: 'claude-code' | 'openclaw' | 'mcp' | 'unknown';
  enabled: boolean;
  error?: string;
  /** Claude Code allowed-tools field (e.g. ["Read", "Grep", "Bash"]). */
  allowedTools?: string[];
  /** OpenClaw required binaries. */
  requiredBins?: string[];
  /** OpenClaw required environment variables. */
  requiredEnv?: string[];
  /** User-configured environment variable values (keys only, values masked). */
  configuredEnvKeys?: string[];
  /** True if this skill is an MCP server (type: mcp). */
  isMcpServer?: boolean;
  /** MCP server command (e.g. "npx @anthropic-ai/mcp-server-gmail"), for a local server. */
  mcpCommand?: string;
  /** MCP server endpoint (e.g. "https://example.com/mcp"), for a remote server. */
  mcpUrl?: string;
  /**
   * MCP server runtime status. `signing_in` means the remote server asked for
   * a sign-in and the person has been asked to approve it.
   */
  mcpStatus?: 'idle' | 'running' | 'signing_in' | 'error';
  /** Path to the MCP server's config file (e.g. ~/.config/email-mcp/config.toml). */
  configFile?: string;
}

/**
 * MCP server metadata parsed from SKILL.md frontmatter. A local server has a
 * `command` (stdio); a remote server has a `url` (HTTP). Exactly one is set.
 */
export interface MCPServerMeta {
  /** Local server: the program to start (`mcp-command`). */
  command?: string;
  /** Local server: its arguments (`mcp-args`). */
  args?: string[];
  /** Remote server: its endpoint (`mcp-url`). */
  url?: string;
  /** Remote server: headers for every request (`mcp-headers`); `${VAR}` is filled from the skill's env. */
  headers?: Record<string, string>;
  /** Remote server: a pre-registered OAuth client id, for a server without dynamic registration (`mcp-oauth-client-id`). */
  oauthClientId?: string;
  requiredEnv?: string[];
}

/** Per-skill configuration stored by SkillRegistry. */
export interface SkillConfig {
  env: Record<string, string>;
}

/** Summary of an enabled skill, used for prompt injection. */
export interface EnabledSkillSummary {
  name: string;
  description: string;
  /** Full markdown body from SKILL.md. */
  instructions: string;
  /** Claude Code allowed-tools (for context). */
  allowedTools?: string[];
  /** Merged environment variables from skill config (for runtime injection). */
  env?: Record<string, string>;
}
