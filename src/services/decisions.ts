import { DomainError, history, supersede, transition, dueForReview } from '../domain/lifecycle';
import { parseDecisionDraft, type DecisionDraft } from '../domain/validate';
import type { Decision, DecisionStatus } from '../domain/types';
import type { Deps } from './context';

function fromDraft(draft: DecisionDraft, deps: Deps, status: DecisionStatus): Decision {
  const ts = deps.now().toISOString();
  return { ...draft, id: deps.newId(), status, createdAt: ts, updatedAt: ts, version: 1 };
}

async function load(deps: Deps, id: string): Promise<Decision> {
  const d = await deps.store.getDecision(id);
  if (!d) throw new DomainError('Decision not found.', 'NOT_FOUND');
  return d;
}

/**
 * Anyone can propose a decision. If the proposer is also the named owner,
 * it is accepted immediately; otherwise the owner must accept it.
 */
export async function createDecision(deps: Deps, raw: unknown, actorAccountId: string): Promise<Decision> {
  const draft = parseDecisionDraft(raw, deps.newId);
  const d = fromDraft(draft, deps, draft.ownerAccountId === actorAccountId ? 'accepted' : 'proposed');
  await deps.store.insertDecision(d);
  return d;
}

export async function changeStatus(deps: Deps, id: string, to: 'accepted' | 'rejected' | 'deprecated', actorAccountId: string): Promise<Decision> {
  const cur = await load(deps, id);
  const next = transition(cur, to, actorAccountId, deps.now());
  await deps.store.updateDecision(next, cur.version);
  return next;
}

/** Replace an accepted decision with a new one. Only the current owner can do this. */
export async function supersedeDecision(deps: Deps, oldId: string, raw: unknown, actorAccountId: string): Promise<{ old: Decision; replacement: Decision }> {
  const old = await load(deps, oldId);
  const draft = parseDecisionDraft(raw, deps.newId);
  const res = supersede(old, fromDraft(draft, deps, 'proposed'), actorAccountId, deps.now());
  // Forge SQL has no multi-statement transactions, so: insert the replacement, then retire the old
  // decision. If retiring fails (someone else changed it), mark the replacement rejected so only
  // one of the two is ever in force.
  await deps.store.insertDecision(res.replacement);
  try {
    await deps.store.updateDecision(res.old, old.version);
  } catch (e) {
    await deps.store.updateDecision({ ...res.replacement, status: 'rejected', supersedesId: undefined, version: 2 }, 1);
    throw e;
  }
  return res;
}

export async function getDecisionWithHistory(deps: Deps, id: string): Promise<{ decision: Decision; history: Decision[] }> {
  const decision = await load(deps, id);
  const all = await deps.store.listDecisions();
  return { decision, history: history(id, new Map(all.map((d) => [d.id, d]))).slice(1) };
}

export async function listDecisions(deps: Deps, opts: { statuses?: DecisionStatus[]; ownerAccountId?: string; sourcePageId?: string } = {}): Promise<Decision[]> {
  return deps.store.listDecisions(opts);
}

export async function decisionsDueForReview(deps: Deps): Promise<Decision[]> {
  return dueForReview(await deps.store.listDecisions({ statuses: ['accepted'] }), deps.now());
}
