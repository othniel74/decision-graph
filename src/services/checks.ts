import { check } from '../domain/engine';
import { DomainError } from '../domain/lifecycle';
import { buildReceipt, type Receipt } from '../domain/receipt';
import type { CheckResult, ProposedAction, Violation } from '../domain/types';
import type { Conflict } from '../storage/store';
import type { Deps } from './context';

export interface CheckOutcome {
  result: CheckResult;
  receipt: Receipt;
  conflicts: Conflict[];
}

const MAX_RECEIPT_RETRIES = 5;

async function appendReceipt(deps: Deps, action: ProposedAction, result: CheckResult): Promise<Receipt> {
  for (let attempt = 0; attempt < MAX_RECEIPT_RETRIES; attempt++) {
    const prev = await deps.store.latestReceipt();
    const receipt = buildReceipt(action, result, prev, deps.newId());
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
 * Open one conflict per violated decision per work item. An existing open conflict
 * for the same decision and issue is reused, so repeated attempts don't spam owners.
 */
async function openConflicts(deps: Deps, action: ProposedAction, violations: Violation[], receiptId: string): Promise<Conflict[]> {
  const byDecision = new Map<string, Violation[]>();
  for (const v of violations) byDecision.set(v.decisionId, [...(byDecision.get(v.decisionId) ?? []), v]);

  const existing = action.item.key
    ? await deps.store.listConflicts({ status: 'open', issueKey: action.item.key, limit: 100 })
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
      status: 'open',
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
}

export async function runCheck(deps: Deps, action: ProposedAction, opts: CheckOptions = {}): Promise<CheckOutcome | { result: CheckResult; receipt: null; conflicts: [] }> {
  const record = opts.record ?? true;
  const [decisions, exceptions] = await Promise.all([
    deps.store.listDecisions({ statuses: ['accepted'] }),
    action.item.key ? deps.store.listExceptions({ issueKey: action.item.key }) : Promise.resolve([]),
  ]);
  const result = check({ action, decisions, exceptions, now: deps.now() });
  if (!record) return { result, receipt: null, conflicts: [] };

  const receipt = await appendReceipt(deps, action, result);
  const conflicts = (opts.openConflicts ?? true) && result.violations.length
    ? await openConflicts(deps, action, result.violations, receipt.id)
    : [];
  return { result, receipt, conflicts };
}
