import { evaluateConstraint } from './constraints';
import { applicableDecisions } from './scope';
import { isExpired } from './time';
import type { CheckResult, Decision, DecisionException, ProposedAction, Verdict, Violation } from './types';

export interface CheckInput {
  action: ProposedAction;
  decisions: Decision[];
  exceptions: DecisionException[];
  now: Date;
}

function findException(
  exceptions: DecisionException[],
  decisionId: string,
  issueKey: string | undefined,
  now: Date,
): DecisionException | undefined {
  if (!issueKey) return undefined;
  return exceptions.find(
    (e) => e.decisionId === decisionId && e.issueKey === issueKey && !isExpired(e.expiresAt, now),
  );
}

export function verdictFor(violations: Violation[]): Verdict {
  if (violations.some((v) => v.enforcement === 'block')) return 'block';
  if (violations.length > 0) return 'warn';
  return 'allow';
}

/**
 * Check a proposed action against the organisation's accepted decisions.
 * Pure and deterministic: the same input always yields the same result.
 */
export function check(input: CheckInput): CheckResult {
  const { action, decisions, exceptions, now } = input;
  const applicable = applicableDecisions(decisions, action.item);
  const violations: Violation[] = [];
  const waived: Violation[] = [];

  for (const d of applicable) {
    const exception = findException(exceptions, d.id, action.item.key, now);
    for (const c of d.constraints) {
      const hit = evaluateConstraint(c, action, now);
      if (!hit) continue;
      const v: Violation = {
        decisionId: d.id,
        decisionTitle: d.title,
        constraintId: c.id,
        constraintKind: c.kind,
        enforcement: d.enforcement,
        ownerAccountId: d.ownerAccountId,
        message: hit.message,
        evidence: hit.evidence,
        sourceUrl: d.sourceUrl,
      };
      if (exception) waived.push({ ...v, exceptionId: exception.id });
      else violations.push(v);
    }
  }

  return {
    verdict: verdictFor(violations),
    violations,
    waived,
    applicableDecisionIds: applicable.map((d) => d.id),
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
  const lines = result.violations.map((v) => `- ${v.decisionTitle}: ${v.message}`);
  return `${lead}:\n${lines.join('\n')}\nAsk the decision owner for an exception, or change the plan.`;
}
