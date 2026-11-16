import { createHash } from 'node:crypto';
import type { CheckResult, ProposedAction } from './types';

/**
 * Tamper-evident audit receipt. Each receipt includes the hash of the previous one,
 * so altering or deleting any past record breaks the chain.
 */
export interface Receipt {
  id: string;
  sequence: number;
  prevHash: string;
  hash: string;
  issueKey?: string;
  projectKey: string;
  actorType: ProposedAction['actorType'];
  actorAccountId?: string;
  actorName?: string;
  actionType: ProposedAction['type'];
  toStatus?: string;
  verdict: CheckResult['verdict'];
  decisionIds: string[];
  violationCount: number;
  waivedCount: number;
  /** Conflicts with decisions in their trial run (absent when zero, so older receipts verify unchanged). */
  shadowCount?: number;
  /** Paths used by connected matches, as "decisionId: A → B → C". */
  paths?: string[];
  /** When the graph used for this check was last fully refreshed. */
  graphAt?: string;
  createdAt: string;
}

export const GENESIS_HASH = '0'.repeat(64);

/** Stable JSON: object keys sorted recursively, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function hashReceipt(r: Omit<Receipt, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(r)).digest('hex');
}

export function buildReceipt(
  action: ProposedAction,
  result: CheckResult,
  prev: { sequence: number; hash: string } | null,
  id: string,
  graphAt: string | null = null,
): Receipt {
  const all = [...result.violations, ...result.waived, ...(result.shadow ?? [])];
  const decisionIds = [...new Set(all.map((v) => v.decisionId))].sort();
  const paths = [...new Set(all.filter((v) => v.via === 'connected' && v.path).map((v) => `${v.decisionId}: ${v.path!.join(' → ')}`))].sort();
  const shadowCount = result.shadow?.length ?? 0;
  const body: Omit<Receipt, 'hash'> = {
    id,
    sequence: prev ? prev.sequence + 1 : 1,
    prevHash: prev ? prev.hash : GENESIS_HASH,
    issueKey: action.item.key,
    projectKey: action.item.projectKey,
    actorType: action.actorType,
    actorAccountId: action.actorAccountId,
    actorName: action.actorName,
    actionType: action.type,
    toStatus: action.toStatus,
    verdict: result.verdict,
    decisionIds,
    violationCount: result.violations.length,
    waivedCount: result.waived.length,
    ...(shadowCount ? { shadowCount } : {}),
    ...(paths.length ? { paths } : {}),
    ...(graphAt && paths.length ? { graphAt } : {}),
    createdAt: result.evaluatedAt,
  };
  return { ...body, hash: hashReceipt(body) };
}

/**
 * Verify a contiguous run of receipts ordered by sequence. Returns the first broken
 * sequence number, or null if intact. A run that starts mid-chain is anchored on its
 * first receipt's prevHash.
 */
export function verifyChain(receipts: Receipt[]): number | null {
  let prevHash = receipts.length && receipts[0].sequence > 1 ? receipts[0].prevHash : GENESIS_HASH;
  let expected = receipts.length ? receipts[0].sequence : 1;
  for (const r of receipts) {
    const { hash, ...body } = r;
    if (r.sequence !== expected || r.prevHash !== prevHash || hashReceipt(body) !== hash) return r.sequence;
    prevHash = hash;
    expected += 1;
  }
  return null;
}
