import type { Decision, DecisionException, DecisionStatus } from '../domain/types';
import type { Receipt } from '../domain/receipt';
import type { Edge, PathOverride } from '../domain/graph';

/** `shadow` = recorded during a decision's trial run; never notified or enforced. */
export type ConflictStatus = 'open' | 'upheld' | 'excepted' | 'superseded' | 'withdrawn' | 'shadow';

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
  /** For connected matches: the path from the work to the decision's page. */
  path?: string[];
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

  /** Replace every edge leaving `from` with `edges` (all must have that `from`). */
  replaceEdgesFrom(from: string, edges: Edge[], at: string): Promise<void>;
  listEdgesFrom(nodes: string[]): Promise<Edge[]>;
  listEdgesTo(nodes: string[]): Promise<Edge[]>;

  listOverrides(filter: { issueKey?: string; decisionId?: string }): Promise<PathOverride[]>;
  /** One override per decision and issue; a new one replaces the old. */
  putOverride(o: PathOverride): Promise<void>;
}
