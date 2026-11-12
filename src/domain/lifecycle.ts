import type { Decision, DecisionStatus } from './types';

export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT',
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

const ALLOWED: Record<DecisionStatus, DecisionStatus[]> = {
  proposed: ['accepted', 'rejected'],
  accepted: ['superseded', 'deprecated'],
  superseded: [],
  deprecated: [],
  rejected: [],
};

export function canTransition(from: DecisionStatus, to: DecisionStatus): boolean {
  return ALLOWED[from].includes(to);
}

/** Only the owner may accept, deprecate or supersede a decision. */
export function assertOwner(d: Decision, accountId: string): void {
  if (d.ownerAccountId !== accountId) {
    throw new DomainError('Only the decision owner can do this.', 'FORBIDDEN');
  }
}

export function transition(d: Decision, to: DecisionStatus, actorAccountId: string, now: Date): Decision {
  assertOwner(d, actorAccountId);
  if (!canTransition(d.status, to)) {
    throw new DomainError(`A ${d.status} decision cannot become ${to}.`, 'CONFLICT');
  }
  return { ...d, status: to, updatedAt: now.toISOString(), version: d.version + 1 };
}

/**
 * Supersede `old` with `replacement`. The replacement is accepted immediately and
 * both records keep a link to each other so the history stays readable.
 */
export function supersede(
  old: Decision,
  replacement: Decision,
  actorAccountId: string,
  now: Date,
): { old: Decision; replacement: Decision } {
  if (old.id === replacement.id) throw new DomainError('A decision cannot supersede itself.', 'INVALID');
  const retired = transition(old, 'superseded', actorAccountId, now);
  return {
    old: { ...retired, supersededById: replacement.id },
    replacement: {
      ...replacement,
      status: 'accepted',
      supersedesId: old.id,
      updatedAt: now.toISOString(),
    },
  };
}

/** Walk the supersession chain back to the original decision, newest first. */
export function history(decisionId: string, byId: Map<string, Decision>): Decision[] {
  const out: Decision[] = [];
  const seen = new Set<string>();
  let cur = byId.get(decisionId);
  while (cur && !seen.has(cur.id)) {
    out.push(cur);
    seen.add(cur.id);
    cur = cur.supersedesId ? byId.get(cur.supersedesId) : undefined;
  }
  return out;
}

/** Decisions due for review: accepted and past their review date. */
export function dueForReview(decisions: Decision[], now: Date): Decision[] {
  return decisions.filter(
    (d) => d.status === 'accepted' && d.reviewBy !== undefined && new Date(d.reviewBy).getTime() <= now.getTime(),
  );
}
