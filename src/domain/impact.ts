import { check } from './engine';
import type { Connection, Decision, DecisionException, DecisionScope, Violation, WorkItem } from './types';

/**
 * Impact analysis: which open work already contradicts a decision.
 * Used when a decision is accepted or superseded, and to preview a draft before saving.
 */

export interface ImpactedItem {
  key: string;
  summary: string;
  status?: string;
  violations: Violation[];
  waived: boolean;
}

export interface ImpactReport {
  decisionId: string;
  scanned: number;
  /** True when the scan stopped at the cap, so there may be more. */
  truncated: boolean;
  affected: ImpactedItem[];
}

/**
 * Evaluate one decision against open work items as they stand. Rules about moving work
 * (restricted status moves, required fields before a status) only fire when work moves, so a
 * standing scan reports terms, labels and components.
 */
export function analyseImpact(
  decision: Decision,
  items: WorkItem[],
  exceptions: DecisionException[],
  now: Date,
  truncated = false,
  connectionsByIssue: Map<string, Connection> = new Map(),
): ImpactReport {
  const asAccepted: Decision = { ...decision, status: 'accepted' };
  const affected: ImpactedItem[] = [];
  for (const item of items) {
    const r = check({
      action: { type: 'update', actorType: 'system', item },
      decisions: [asAccepted],
      exceptions: exceptions.filter((e) => e.decisionId === decision.id),
      now,
      connections: item.key && connectionsByIssue.has(item.key) ? new Map([[decision.id, connectionsByIssue.get(item.key)!]]) : undefined,
    });
    // During a trial run the would-be conflicts are what an owner wants to see.
    const live = [...r.violations, ...r.shadow];
    if (live.length || r.waived.length) {
      affected.push({
        key: item.key ?? '',
        summary: item.summary ?? '',
        status: item.status,
        violations: live,
        waived: live.length === 0,
      });
    }
  }
  // Unwaived first, then by key for a stable order.
  affected.sort((a, b) => Number(a.waived) - Number(b.waived) || a.key.localeCompare(b.key, undefined, { numeric: true }));
  return { decisionId: decision.id, scanned: items.length, truncated, affected };
}

const SAFE_KEY = /^[A-Z][A-Z0-9_]+$/;

/** JQL string literal: double quotes, with backslashes and quotes escaped. */
export function jqlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Open work among specific issue keys (for connected reach). Keys are validated. */
export function keysToJql(keys: string[]): string | null {
  const safe = keys.filter((k) => /^[A-Z][A-Z0-9_]+-\d+$/.test(k)).slice(0, 500);
  return safe.length ? `key in (${safe.join(', ')}) AND statusCategory != Done ORDER BY updated DESC` : null;
}

/** Open (not Done) work in the decision's scope. */
export function scopeToJql(scope: DecisionScope): string {
  const clauses: string[] = ['statusCategory != Done'];
  const keys = scope.projectKeys.filter((k) => SAFE_KEY.test(k));
  if (keys.length) clauses.unshift(`project in (${keys.map(jqlString).join(', ')})`);
  if (scope.issueTypes.length) clauses.push(`issuetype in (${scope.issueTypes.map(jqlString).join(', ')})`);
  if (scope.components.length) clauses.push(`component in (${scope.components.map(jqlString).join(', ')})`);
  if (scope.labels.length) clauses.push(`labels in (${scope.labels.map(jqlString).join(', ')})`);
  return `${clauses.join(' AND ')} ORDER BY updated DESC`;
}
