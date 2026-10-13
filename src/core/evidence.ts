/**
 * Learning evidence, by reference.
 *
 * A learning decision cites the records that justify it: task records,
 * observations (a prediction beside what happened) and assessments. Those
 * records are large (a task record carries a transcript; an observation can
 * carry a whole job result), and they used to be copied into every decision
 * and into every knowledge receipt that cited them, so one belief could
 * carry megabytes of other goals' transcripts.
 *
 * Now each cited record is stored once by content hash in GoalManager's
 * evidence store, and what travels is a reference: the hash plus a digest of
 * the prediction-level facts (what was expected, what happened, the verdict,
 * the explanation, what was blamed). The digest is enough to say why a
 * belief changed; the body stays reachable by hash for anyone who needs it.
 *
 * The digest fields match evidence_digest in native/knowledge-base.
 */

import { require as precondition, ensure } from './contracts.js';
import { learningFingerprint } from './learning.js';

/** Storage key prefix of evidence bodies: `evidence:<sha256>`. */
export const EVIDENCE_KEY_PREFIX = 'evidence:';
/** Characters kept per text field of a digest. */
export const EVIDENCE_TEXT_CAP = 400;
/** An observation result longer than this is stored by hash, with an excerpt inline. */
export const OBSERVATION_INLINE_CAP = 4000;

/** A cited record as decisions and receipts carry it. */
export interface EvidenceReference {
  hash: string;
  digest: Record<string, unknown>;
  /** An assessment's revision, which reconsideration compares. */
  revision?: number;
}

const SCALAR_FIELDS = ['taskId', 'step', 'action', 'outcome', 'verdict', 'phase', 'revision', 'missed', 'agentName'] as const;
const TEXT_FIELDS = ['expect', 'explanation', 'error', 'result', 'actual'] as const;

function clippedText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > EVIDENCE_TEXT_CAP ? text.slice(0, EVIDENCE_TEXT_CAP) : text;
}

/** The prediction-level facts of one evidence record. */
export function evidenceDigest(record: unknown): Record<string, unknown> {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { value: clippedText(record) };
  const r = record as Record<string, unknown>;
  const digest: Record<string, unknown> = {};
  for (const key of SCALAR_FIELDS) {
    const v = r[key];
    if (typeof v === 'string') digest[key] = v.length > EVIDENCE_TEXT_CAP ? v.slice(0, EVIDENCE_TEXT_CAP) : v;
    else if (typeof v === 'number' || typeof v === 'boolean') digest[key] = v;
  }
  for (const key of TEXT_FIELDS) if (r[key] !== undefined && r[key] !== null) digest[key] = clippedText(r[key]);
  if (r.attribution && typeof r.attribution === 'object') {
    const a = r.attribution as Record<string, unknown>;
    digest.attribution = JSON.stringify(a).length <= EVIDENCE_TEXT_CAP ? a : { source: a.source };
  }
  return digest;
}

/** A reference to a record: its content hash and digest. */
export async function evidenceReference(record: unknown): Promise<EvidenceReference> {
  const hash = await learningFingerprint(record);
  const revision = record && typeof record === 'object' ? (record as { revision?: unknown }).revision : undefined;
  const reference: EvidenceReference = { hash, digest: evidenceDigest(record), ...(typeof revision === 'number' ? { revision } : {}) };
  ensure(/^[0-9a-f]{64}$/.test(reference.hash), 'evidence hash is a sha256 hex digest');
  return reference;
}

/** True for a value that is a reference rather than a whole record. */
export function isEvidenceReference(value: unknown): value is EvidenceReference {
  return !!value && typeof value === 'object' && typeof (value as EvidenceReference).hash === 'string'
    && !!(value as EvidenceReference).digest && typeof (value as EvidenceReference).digest === 'object';
}

/** The Storage key of an evidence body. */
export function evidenceKey(hash: string): string {
  precondition(/^[0-9a-f]{64}$/.test(hash), 'evidence hash is a sha256 hex digest');
  return `${EVIDENCE_KEY_PREFIX}${hash}`;
}
