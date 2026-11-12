import { DomainError } from '../domain/lifecycle';
import { str } from '../domain/validate';
import type { DecisionException } from '../domain/types';
import type { Conflict } from '../storage/store';
import type { Deps } from './context';

async function loadConflict(deps: Deps, id: string): Promise<Conflict> {
  const c = await deps.store.getConflict(id);
  if (!c) throw new DomainError('Conflict not found.', 'NOT_FOUND');
  return c;
}

/** The person who hit the conflict (or anyone who can see it) explains why an exception is needed. */
export async function requestException(deps: Deps, conflictId: string, noteRaw: unknown, actorAccountId: string): Promise<Conflict> {
  const c = await loadConflict(deps, conflictId);
  if (c.status !== 'open') throw new DomainError('This conflict is already resolved.', 'CONFLICT');
  const note = str(noteRaw, 'note', { max: 2000 });
  const next = { ...c, requestNote: `${note} (requested by ${actorAccountId})` };
  await deps.store.updateConflict(next);
  return next;
}

export type Resolution = 'uphold' | 'grant_exception' | 'withdraw';

/**
 * Resolve a conflict. Upholding and granting exceptions are owner-only;
 * the person who triggered a conflict may withdraw it (they changed their plan).
 */
export async function resolveConflict(
  deps: Deps,
  input: { conflictId: string; resolution: Resolution; note?: unknown; expiresAt?: unknown },
  actorAccountId: string,
): Promise<{ conflict: Conflict; exception?: DecisionException }> {
  const c = await loadConflict(deps, input.conflictId);
  if (c.status !== 'open') throw new DomainError('This conflict is already resolved.', 'CONFLICT');
  const decision = await deps.store.getDecision(c.decisionId);
  if (!decision) throw new DomainError('The decision behind this conflict no longer exists.', 'NOT_FOUND');
  const now = deps.now().toISOString();
  const note = str(input.note, 'note', { required: input.resolution === 'grant_exception', max: 2000 });

  if (input.resolution === 'withdraw') {
    if (actorAccountId !== c.actorAccountId && actorAccountId !== decision.ownerAccountId) {
      throw new DomainError('Only the person who raised this, or the decision owner, can withdraw it.', 'FORBIDDEN');
    }
    const conflict: Conflict = { ...c, status: 'withdrawn', resolutionNote: note || undefined, resolvedByAccountId: actorAccountId, resolvedAt: now };
    await deps.store.updateConflict(conflict);
    return { conflict };
  }

  if (actorAccountId !== decision.ownerAccountId) {
    throw new DomainError('Only the decision owner can resolve this conflict.', 'FORBIDDEN');
  }

  if (input.resolution === 'uphold') {
    const conflict: Conflict = { ...c, status: 'upheld', resolutionNote: note || undefined, resolvedByAccountId: actorAccountId, resolvedAt: now };
    await deps.store.updateConflict(conflict);
    return { conflict };
  }

  if (!c.issueKey) throw new DomainError('Exceptions can only be granted for a specific work item.', 'INVALID');
  const expiresAt = str(input.expiresAt, 'expiresAt', { required: false, max: 40 });
  if (expiresAt && (Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= deps.now().getTime())) {
    throw new DomainError('expiresAt must be a future date.', 'INVALID');
  }
  const exception: DecisionException = {
    id: deps.newId(),
    decisionId: c.decisionId,
    issueKey: c.issueKey,
    grantedByAccountId: actorAccountId,
    reason: note,
    expiresAt: expiresAt || undefined,
    createdAt: now,
  };
  await deps.store.insertException(exception);
  const conflict: Conflict = { ...c, status: 'excepted', resolutionNote: note, resolvedByAccountId: actorAccountId, resolvedAt: now };
  await deps.store.updateConflict(conflict);
  return { conflict, exception };
}

/** Open conflicts waiting on decisions this person owns. */
export async function myReviewQueue(deps: Deps, ownerAccountId: string): Promise<Conflict[]> {
  const owned = await deps.store.listDecisions({ ownerAccountId });
  return deps.store.listConflicts({ status: 'open', ownerDecisionIds: owned.map((d) => d.id), limit: 100 });
}
