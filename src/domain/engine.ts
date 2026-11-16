import { evaluateConstraint } from './constraints';
import { isEnforceable, scopeMatches } from './scope';
import { isExpired } from './time';
import type { CheckResult, Connection, Decision, DecisionException, DecisionScope, ProposedAction, Reach, Verdict, Violation } from './types';

export interface CheckInput {
  action: ProposedAction;
  decisions: Decision[];
  exceptions: DecisionException[];
  now: Date;
  /** Connections from this work item to decisions, keyed by decision id (from the graph). */
  connections?: Map<string, Connection>;
  /** The graph was too old to trust; connected matching is off for this check. */
  graphStale?: boolean;
}

const scopeIsEmpty = (s: DecisionScope) => !s.projectKeys.length && !s.issueTypes.length && !s.components.length && !s.labels.length;

/**
 * A decision recorded on a Confluence page with no scope reaches work through links only;
 * with a scope as well, either way. Without a page it uses its scope (empty scope = everywhere).
 */
export function reachOf(d: Pick<Decision, 'reach' | 'sourcePageId' | 'scope'>): Reach {
  if (d.reach) return d.reach;
  if (!d.sourcePageId) return 'scope';
  return scopeIsEmpty(d.scope) ? 'connected' : 'both';
}

export function inTrial(d: Pick<Decision, 'trialUntil'>, now: Date): boolean {
  return d.trialUntil !== undefined && Date.parse(d.trialUntil) > now.getTime();
}

function findException(exceptions: DecisionException[], decisionId: string, issueKey: string | undefined, now: Date) {
  if (!issueKey) return undefined;
  return exceptions.find((e) => e.decisionId === decisionId && e.issueKey === issueKey && !isExpired(e.expiresAt, now));
}

export function verdictFor(violations: Violation[]): Verdict {
  if (violations.some((v) => v.enforcement === 'block')) return 'block';
  if (violations.length > 0) return 'warn';
  return 'allow';
}

interface Applicability {
  decision: Decision;
  via: 'scope' | 'connected';
  connection?: Connection;
}

function applicability(d: Decision, input: CheckInput): Applicability | null {
  if (!isEnforceable(d)) return null;
  const reach = reachOf(d);
  if ((reach === 'scope' || reach === 'both') && scopeMatches(d.scope, input.action.item)) return { decision: d, via: 'scope' };
  if ((reach === 'connected' || reach === 'both') && !input.graphStale) {
    const connection = input.connections?.get(d.id);
    if (connection) return { decision: d, via: 'connected', connection };
  }
  return null;
}

/**
 * Check a proposed action against accepted decisions. Pure and deterministic.
 * Two gates: a decision must apply (scope or a graph connection), and one of its rules must fire.
 * Matches inferred through the graph only warn unless the owner confirmed that path.
 * Decisions in their trial run record conflicts in `shadow` and never affect the verdict.
 */
export function check(input: CheckInput): CheckResult {
  const { action, decisions, exceptions, now } = input;
  const applicable = decisions.map((d) => applicability(d, input)).filter((a): a is Applicability => a !== null);
  const violations: Violation[] = [];
  const waived: Violation[] = [];
  const shadow: Violation[] = [];

  for (const { decision: d, via, connection } of applicable) {
    const exception = findException(exceptions, d.id, action.item.key, now);
    const capped = via === 'connected' && !connection?.confirmed && d.enforcement === 'block';
    for (const c of d.constraints) {
      const hit = evaluateConstraint(c, action, now);
      if (!hit) continue;
      const v: Violation = {
        decisionId: d.id,
        decisionTitle: d.title,
        constraintId: c.id,
        constraintKind: c.kind,
        enforcement: capped ? 'warn' : d.enforcement,
        ownerAccountId: d.ownerAccountId,
        message: hit.message,
        evidence: hit.evidence,
        sourceUrl: d.sourceUrl,
        via,
        ...(connection ? { path: connection.path } : {}),
        ...(capped ? { capped: true } : {}),
      };
      if (inTrial(d, now)) shadow.push(v);
      else if (exception) waived.push({ ...v, exceptionId: exception.id });
      else violations.push(v);
    }
  }

  return {
    verdict: verdictFor(violations),
    violations,
    waived,
    shadow,
    applicableDecisionIds: applicable.map((a) => a.decision.id),
    ...(input.graphStale ? { graphStale: true } : {}),
    evaluatedAt: now.toISOString(),
  };
}

/** A short, plain explanation suitable for a Jira validator error or an agent response. */
export function summarise(result: CheckResult): string {
  if (result.verdict === 'allow') {
    return result.waived.length
      ? `Allowed. ${result.waived.length} conflict(s) covered by an owner-approved exception.`
      : 'Allowed. No conflicts with accepted decisions.';
  }
  const lead = result.verdict === 'block' ? 'Blocked by team decisions' : 'Conflicts with team decisions';
  const lines = result.violations.map((v) => {
    const why = v.via === 'connected' && v.path?.length ? ` (applies via ${v.path.join(' → ')})` : '';
    return `- ${v.decisionTitle}: ${v.message}${why}`;
  });
  return `${lead}:\n${lines.join('\n')}\nAsk the decision owner for an exception, or change the plan.`;
}
