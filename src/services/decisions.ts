import { DomainError, history, supersede, transition, dueForReview, startTrial, endTrial } from '../domain/lifecycle';
import { parseDecisionDraft, type DecisionDraft } from '../domain/validate';
import type { Decision, DecisionStatus } from '../domain/types';
import type { Deps } from './context';

export function fromDraft(draft: DecisionDraft, deps: Deps, status: DecisionStatus): Decision {
  const now = deps.now();
  const ts = now.toISOString();
  const { trialDays, ...rest } = draft;
  const d: Decision = { ...rest, ...(trialDays ? { trialDays } : {}), id: deps.newId(), status, createdAt: ts, updatedAt: ts, version: 1 };
  return status === 'accepted' ? startTrial(d, now) : d;
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

/** Owner ends a trial run early; the decision is enforced from now. */
export async function enforceNow(deps: Deps, id: string, actorAccountId: string): Promise<Decision> {
  const cur = await load(deps, id);
  const next = endTrial(cur, actorAccountId, deps.now());
  await deps.store.updateDecision(next, cur.version);
  return next;
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

const DAY = 86_400_000;

/**
 * Owner confirms a decision is still right after review. The next review date moves forward
 * (default six months). The receipt trail keeps the history; the decision records when it was last reviewed.
 */
export async function confirmStillValid(deps: Deps, id: string, actorAccountId: string, nextReviewBy?: unknown): Promise<Decision> {
  const cur = await load(deps, id);
  if (cur.ownerAccountId !== actorAccountId) throw new DomainError('Only the decision owner can confirm it after review.', 'FORBIDDEN');
  if (cur.status !== 'accepted') throw new DomainError('Only accepted decisions are reviewed.', 'INVALID');
  const now = deps.now();
  let next: string;
  if (nextReviewBy === undefined || nextReviewBy === null || nextReviewBy === '') {
    next = new Date(now.getTime() + 182 * DAY).toISOString().slice(0, 10);
  } else if (typeof nextReviewBy === 'string' && !Number.isNaN(Date.parse(nextReviewBy)) && Date.parse(nextReviewBy) > now.getTime()) {
    next = nextReviewBy.slice(0, 10);
  } else {
    throw new DomainError('The next review date must be in the future.', 'INVALID');
  }
  const updated: Decision = { ...cur, reviewBy: next, lastReviewedAt: now.toISOString(), updatedAt: now.toISOString(), version: cur.version + 1 };
  await deps.store.updateDecision(updated, cur.version);
  return updated;
}

/**
 * Hand a decision to a new owner. The current owner can do this; so can a Jira administrator,
 * for when the owner has left and the decision would otherwise have nobody to approve exceptions.
 */
export async function reassignOwner(deps: Deps, id: string, newOwner: unknown, actorAccountId: string, actorIsAdmin: boolean): Promise<Decision> {
  const cur = await load(deps, id);
  if (cur.ownerAccountId !== actorAccountId && !actorIsAdmin) {
    throw new DomainError('Only the decision owner or a Jira administrator can change the owner.', 'FORBIDDEN');
  }
  if (typeof newOwner !== 'string' || !newOwner.trim() || newOwner.length > 128) throw new DomainError('Choose the new owner.', 'INVALID');
  if (!['accepted', 'proposed'].includes(cur.status)) throw new DomainError('Only accepted or proposed decisions can change owner.', 'INVALID');
  const ts = deps.now().toISOString();
  const updated: Decision = { ...cur, ownerAccountId: newOwner, updatedAt: ts, version: cur.version + 1 };
  await deps.store.updateDecision(updated, cur.version);
  return updated;
}
