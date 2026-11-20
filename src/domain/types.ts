/**
 * Core domain model for DecisionGraph.
 *
 * Everything in src/domain is pure: no Forge APIs, no I/O, no clocks.
 * Time and identity are passed in so the engine is deterministic and testable.
 */

export type DecisionStatus = 'proposed' | 'accepted' | 'superseded' | 'deprecated' | 'rejected';

/** How a conflict with this decision is handled. */
export type Enforcement = 'warn' | 'block';

/**
 * How a decision finds the work it applies to.
 * - scope: matches projects, issue types, components and labels.
 * - connected: work linked to the decision's Confluence page (directly or via a parent issue).
 * - both: either way.
 */
export type Reach = 'scope' | 'connected' | 'both';

export type AgentPolicy = 'same' | 'require_human';

/** Which work items a decision applies to. Empty arrays mean "any". */
export interface DecisionScope {
  projectKeys: string[];
  issueTypes: string[];
  components: string[];
  labels: string[];
}

/**
 * Deterministic constraint types. An LLM may *draft* these, but the engine
 * never asks a model whether something conflicts.
 */
export type Constraint =
  | {
      /** Work item text (summary/description/proposal) must not mention these terms. */
      kind: 'forbid_terms';
      id: string;
      terms: string[];
      fields: TextField[];
      /** Phrases that are fine even though they contain a term, e.g. "tokenised card number". */
      allow?: string[];
    }
  | {
      /** Work item must not carry any of these labels. */
      kind: 'forbid_labels';
      id: string;
      labels: string[];
    }
  | {
      /** Work item must not be in any of these components. */
      kind: 'forbid_components';
      id: string;
      components: string[];
    }
  | {
      /** Moving into one of these statuses is restricted. */
      kind: 'restrict_transition';
      id: string;
      toStatuses: string[];
      /** Optional freeze window; if absent the restriction always applies. */
      window?: FreezeWindow;
    }
  | {
      /** A field must be present (non-empty) before the work item may enter these statuses. */
      kind: 'require_field';
      id: string;
      field: string;
      fieldLabel: string;
      whenEnteringStatuses: string[];
    };

export type ConstraintKind = Constraint['kind'];

export type TextField = 'summary' | 'description' | 'proposal';

/** Days are 0 (Sunday) to 6 (Saturday); hours are 0-23 in the given IANA timezone. */
export interface FreezeWindow {
  days: number[];
  fromHour: number;
  toHour: number;
  timezone: string;
}

export interface Decision {
  id: string;
  title: string;
  /** Plain-language statement of what was decided. */
  statement: string;
  rationale: string;
  ownerAccountId: string;
  status: DecisionStatus;
  enforcement: Enforcement;
  scope: DecisionScope;
  constraints: Constraint[];
  /** Where the decision is recorded, e.g. a Confluence page. */
  sourceUrl?: string;
  sourcePageId?: string;
  supersedesId?: string;
  supersededById?: string;
  /** ISO date after which the decision should be reviewed. */
  reviewBy?: string;
  /** Created by the demo seeder, so it can be recognised and not seeded twice. */
  demo?: boolean;
  /** How the decision reaches work. Defaults from scope and source page (see reachOf). */
  reach?: Reach;
  /**
   * How conflicts by agents and automations are handled. `require_human`: always blocked, so a
   * person must approve ("co-pilot before autopilot"); people get the decision's normal enforcement.
   */
  agentPolicy?: AgentPolicy;
  /** When the owner last confirmed the decision is still right. */
  lastReviewedAt?: string;
  /** Conditions under which the decision should be reconsidered, e.g. "if we change payment provider". */
  revisitIf?: string;
  /** Length of the trial run, started when the decision is accepted. */
  trialDays?: number;
  /** While now is before this, conflicts are recorded quietly ("would have flagged") and nothing is blocked. */
  trialUntil?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** A snapshot of the work being checked. Built by adapters from Jira or from an agent's proposal. */
export interface WorkItem {
  key?: string;
  projectKey: string;
  issueType?: string;
  summary?: string;
  description?: string;
  /** Free text from an agent describing what it intends to do. */
  proposal?: string;
  labels: string[];
  components: string[];
  status?: string;
  /** Arbitrary field values keyed by field id (e.g. customfield_10042). */
  fields: Record<string, unknown>;
}

export type ActorType = 'human' | 'rovo_agent' | 'mcp_client' | 'automation' | 'system';

export type ActionType = 'create' | 'update' | 'transition' | 'proposal';

export interface ProposedAction {
  type: ActionType;
  actorType: ActorType;
  actorAccountId?: string;
  /** Agent or client name, when the actor is not a human. */
  actorName?: string;
  /** For transitions: the target status name. */
  toStatus?: string;
  item: WorkItem;
}

/** An owner-granted exception for one decision on one work item. */
export interface DecisionException {
  id: string;
  decisionId: string;
  issueKey: string;
  grantedByAccountId: string;
  reason: string;
  expiresAt?: string;
  createdAt: string;
}

export interface Violation {
  decisionId: string;
  decisionTitle: string;
  constraintId: string;
  constraintKind: ConstraintKind;
  enforcement: Enforcement;
  ownerAccountId: string;
  /** Human-readable explanation, safe to show to users and agents. */
  message: string;
  /** Concrete evidence: the term, label, status, etc. that triggered the violation. */
  evidence: string[];
  sourceUrl?: string;
  exceptionId?: string;
  /** How the decision reached this work. */
  via: 'scope' | 'connected';
  /** For connected matches: the readable path from the work to the decision's page. */
  path?: string[];
  /** True when enforcement was lowered to warn because the match was inferred and not confirmed. */
  capped?: boolean;
  /** True when enforcement was raised to block because an agent or automation acted. */
  agentStrict?: boolean;
}

/** A connection from a work item to a decision's page, found in the graph. */
export interface Connection {
  path: string[];
  /** The decision owner confirmed this path, so the decision may block through it. */
  confirmed: boolean;
}

export type Verdict = 'allow' | 'warn' | 'block';

export interface CheckResult {
  verdict: Verdict;
  /** Violations that still apply (not covered by an exception). */
  violations: Violation[];
  /** Violations waived by an owner exception, kept for the audit trail. */
  waived: Violation[];
  /** Conflicts with decisions still in their trial run: recorded, never enforced. */
  shadow: Violation[];
  /** Decisions that applied (by scope or connection), whether or not they were violated. */
  applicableDecisionIds: string[];
  /** True when connected matching was skipped because the graph is out of date. */
  graphStale?: boolean;
  evaluatedAt: string;
}
