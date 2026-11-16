import { check } from '../domain/engine';
import { DomainError } from '../domain/lifecycle';
import { buildReceipt, type Receipt } from '../domain/receipt';
import type { CheckResult, Decision, ProposedAction, Violation } from '../domain/types';
import type { Conflict } from '../storage/store';
import type { Deps } from './context';
import { connectionsForItem } from './graph';

export interface CheckOutcome {
  result: CheckResult;
  receipt: Receipt;
  conflicts: Conflict[];
}

const MAX_RECEIPT_RETRIES = 5;

async function appendReceipt(deps: Deps, action: ProposedAction, result: CheckResult, graphAt: string | null): Promise<Receipt> {
  for (let attempt = 0; attempt < MAX_RECEIPT_RETRIES; attempt++) {
    const prev = await deps.store.latestReceipt();
    const receipt = buildReceipt(action, result, prev, deps.newId(), graphAt);
    try {
      await deps.store.insertReceipt(receipt);
      return receipt;
    } catch (e) {
      if (e instanceof DomainError && e.code === 'CONFLICT') continue; // another writer took the sequence
      throw e;
    }
  }
  throw new Error('Could not record the audit receipt after several attempts. Try again.');
}

/**
 * Open one conflict per violated decision per work item. An existing conflict with the same
 * status for the same decision and issue is reused, so repeated attempts don't spam owners.
 * Trial-run ("shadow") conflicts are kept separately and never notified.
 */
async function openConflicts(
  deps: Deps,
  action: ProposedAction,
  violations: Violation[],
  receiptId: string,
  status: 'open' | 'shadow' = 'open',
): Promise<Conflict[]> {
  const byDecision = new Map<string, Violation[]>();
  for (const v of violations) byDecision.set(v.decisionId, [...(byDecision.get(v.decisionId) ?? []), v]);

  const existing = action.item.key
    ? await deps.store.listConflicts({ status, issueKey: action.item.key, limit: 100 })
    : [];

  const out: Conflict[] = [];
  for (const [decisionId, vs] of byDecision) {
    const open = existing.find((c) => c.decisionId === decisionId);
    if (open) {
      out.push(open);
      continue;
    }
    const c: Conflict = {
      id: deps.newId(),
      decisionId,
      issueKey: action.item.key,
      projectKey: action.item.projectKey,
      actorType: action.actorType,
      actorAccountId: action.actorAccountId,
      actorName: action.actorName,
      message: vs.map((v) => v.message).join(' '),
      evidence: vs.flatMap((v) => v.evidence),
      ...(vs[0].path ? { path: vs[0].path } : {}),
      status,
      receiptId,
      createdAt: deps.now().toISOString(),
    };
    await deps.store.insertConflict(c);
    out.push(c);
  }
  return out;
}

export interface CheckOptions {
  /** Record a receipt (default true). Read-only previews, like the issue panel, pass false. */
  record?: boolean;
  /** Open conflicts for owners to review (default: only when recording). */
  openConflicts?: boolean;
  /** Accepted decisions already loaded by the caller, to avoid a second read. */
  decisions?: Decision[];
}

export async function runCheck(deps: Deps, action: ProposedAction, opts: CheckOptions = {}): Promise<CheckOutcome | { result: CheckResult; receipt: null; conflicts: [] }> {
  const record = opts.record ?? true;
  const [decisions, exceptions] = await Promise.all([
    opts.decisions ? Promise.resolve(opts.decisions.filter((d) => d.status === 'accepted')) : deps.store.listDecisions({ statuses: ['accepted'] }),
    action.item.key ? deps.store.listExceptions({ issueKey: action.item.key }) : Promise.resolve([]),
  ]);
  const graph = await connectionsForItem(deps, action.item.key, decisions);
  const result = check({ action, decisions, exceptions, now: deps.now(), connections: graph.connections, graphStale: graph.stale });
  if (!record) return { result, receipt: null, conflicts: [] };

  const receipt = await appendReceipt(deps, action, result, graph.connections.size ? graph.graphAt : null);
  const wantConflicts = opts.openConflicts ?? true;
  const conflicts = wantConflicts && result.violations.length ? await openConflicts(deps, action, result.violations, receipt.id) : [];
  if (wantConflicts && result.shadow.length) await openConflicts(deps, action, result.shadow, receipt.id, 'shadow');
  return { result, receipt, conflicts };
}
