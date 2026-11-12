import type { Decision, DecisionException, DecisionStatus } from '../domain/types';
import type { Receipt } from '../domain/receipt';

export type ConflictStatus = 'open' | 'upheld' | 'excepted' | 'superseded' | 'withdrawn';

/** A conflict waiting for, or resolved by, the decision owner. */
export interface Conflict {
  id: string;
  decisionId: string;
  issueKey?: string;
  projectKey: string;
  actorType: Receipt['actorType'];
  actorAccountId?: string;
  actorName?: string;
  message: string;
  evidence: string[];
  status: ConflictStatus;
  requestNote?: string;
  resolutionNote?: string;
  resolvedByAccountId?: string;
  receiptId: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface DecisionFilter {
  statuses?: DecisionStatus[];
  ownerAccountId?: string;
  sourcePageId?: string;
}

/**
 * Persistence port. The Forge SQL implementation is used in production;
 * the in-memory one backs tests and local development.
 */
export interface Store {
  listDecisions(filter?: DecisionFilter): Promise<Decision[]>;
  getDecision(id: string): Promise<Decision | null>;
  insertDecision(d: Decision): Promise<void>;
  /** Optimistic concurrency: fails with CONFLICT if the stored version is not `expectedVersion`. */
  updateDecision(d: Decision, expectedVersion: number): Promise<void>;

  listExceptions(filter: { issueKey?: string; decisionId?: string }): Promise<DecisionException[]>;
  insertException(e: DecisionException): Promise<void>;

  latestReceipt(): Promise<Receipt | null>;
  /** Fails with CONFLICT if the sequence is already taken (concurrent writer). */
  insertReceipt(r: Receipt): Promise<void>;
  listReceipts(opts: { fromSequence?: number; limit: number; issueKey?: string }): Promise<Receipt[]>;

  insertConflict(c: Conflict): Promise<void>;
  getConflict(id: string): Promise<Conflict | null>;
  updateConflict(c: Conflict): Promise<void>;
  listConflicts(filter: { status?: ConflictStatus; ownerDecisionIds?: string[]; issueKey?: string; limit: number }): Promise<Conflict[]>;

  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
}
