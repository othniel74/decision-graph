import { summarise } from '../domain/engine';
import { DomainError } from '../domain/lifecycle';
import { str } from '../domain/validate';
import type { ActorType, ProposedAction, WorkItem } from '../domain/types';
import { fetchWorkItem, requiredFieldIds } from '../adapters/jira';
import { runCheck } from '../services/checks';
import { createDecision, getDecisionWithHistory } from '../services/decisions';
import { requestException } from '../services/reviews';
import { scopeMatches } from '../domain/scope';
import { deps, safely } from './runtime';

/**
 * Rovo actions. The same functions back the Rovo agent and the rovo:mcp tools, so any agent
 * (Rovo, Claude, Cursor...) can ask "may I do this?" before acting.
 * Actions return plain text: agents relay it to the user.
 */

interface ActionContext {
  jira?: { issueKey?: string; projectKey?: string };
}
interface Payload extends Record<string, unknown> {
  context?: ActionContext;
}
interface RequestContext {
  principal?: { accountId?: string };
  accountId?: string;
}

const accountOf = (ctx?: RequestContext) => ctx?.principal?.accountId ?? ctx?.accountId;
const list = (v: unknown) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

function render<T>(r: { ok: true; data: T } | { ok: false; error: string }, ok: (d: T) => string): string {
  return r.ok ? ok(r.data) : `DecisionGraph could not complete this: ${r.error}`;
}

function checkPlan(actorType: ActorType) {
  return async (payload: Payload, ctx?: RequestContext): Promise<string> => {
    const r = await safely(async () => {
      const plan = str(payload.plan, 'plan', { max: 8000 });
      const rawKey = str(payload.issueKey, 'issueKey', { required: false, max: 40 }) || payload.context?.jira?.issueKey || '';
      const issueKey = rawKey.toUpperCase();
      if (issueKey && !ISSUE_KEY.test(issueKey)) throw new DomainError(`"${rawKey}" is not a Jira issue key.`, 'INVALID');
      const d = deps();
      let item: WorkItem;
      const decisions = await d.store.listDecisions({ statuses: ['accepted'] });
      if (issueKey) {
        // Read as the invoking user so the agent can't learn about issues the user can't see.
        item = { ...(await fetchWorkItem(issueKey, requiredFieldIds(decisions), 'user')), proposal: plan };
      } else {
        const projectKey = (str(payload.projectKey, 'projectKey', { required: false, max: 20 }) || payload.context?.jira?.projectKey || '').toUpperCase();
        if (!projectKey) throw new DomainError('Give either issueKey or projectKey so I know which decisions apply.', 'INVALID');
        item = { projectKey, proposal: plan, labels: list(payload.labels), components: list(payload.components), fields: {} };
      }
      const action: ProposedAction = {
        type: 'proposal',
        actorType,
        actorAccountId: accountOf(ctx),
        actorName: str(payload.agentName, 'agentName', { required: false, max: 100 }) || undefined,
        toStatus: str(payload.targetStatus, 'targetStatus', { required: false, max: 60 }) || undefined,
        item,
      };
      return runCheck(d, action, { decisions });
    });
    return render(r, (o) => {
      const res = o.result;
      const lines = [summarise(res)];
      for (const v of res.violations) {
        lines.push(`Decision ${v.decisionId} "${v.decisionTitle}" (owner account ${v.ownerAccountId})${v.sourceUrl ? ` - ${v.sourceUrl}` : ''}`);
      }
      for (const c of o.conflicts) lines.push(`Conflict ${c.id} is open for the owner to review. To ask for an exception, call request-exception with this id.`);
      lines.push(`Verdict: ${res.verdict.toUpperCase()}. Receipt #${o.receipt?.sequence}.`);
      if (res.verdict === 'block') lines.push('Do not carry out this plan unless the owner grants an exception.');
      return lines.join('\n');
    });
  };
}

export const checkPlanRovo = checkPlan('rovo_agent');
export const checkPlanMcp = checkPlan('mcp_client');

export async function listApplicableDecisions(payload: Payload): Promise<string> {
  const r = await safely(async () => {
    const projectKey = (str(payload.projectKey, 'projectKey', { required: false, max: 20 }) || payload.context?.jira?.projectKey || '').toUpperCase();
    const all = await deps().store.listDecisions({ statuses: ['accepted'] });
    const probe: WorkItem = { projectKey, labels: list(payload.labels), components: list(payload.components), fields: {} };
    return projectKey ? all.filter((d) => scopeMatches({ ...d.scope, issueTypes: [] }, probe)) : all;
  });
  return render(r, (ds) =>
    ds.length
      ? ds.slice(0, 30).map((d) => `- [${d.id}] ${d.title} (${d.enforcement}): ${d.statement}`).join('\n')
      : 'No accepted decisions apply here.',
  );
}

export async function explainDecision(payload: Payload): Promise<string> {
  const r = await safely(async () => getDecisionWithHistory(deps(), str(payload.decisionId, 'decisionId', { max: 64 })));
  return render(r, ({ decision: d, history }) =>
    [
      `${d.title} (${d.status}, ${d.enforcement})`,
      `Decided: ${d.statement}`,
      d.rationale ? `Why: ${d.rationale}` : '',
      `Owner account: ${d.ownerAccountId}`,
      d.sourceUrl ? `Source: ${d.sourceUrl}` : '',
      history.length ? `Replaces: ${history.map((h) => `${h.title} (${h.id})`).join(' <- ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

export async function requestExceptionAction(payload: Payload, ctx?: RequestContext): Promise<string> {
  const actor = accountOf(ctx);
  const r = await safely(async () => {
    if (!actor) throw new DomainError('Could not identify the requesting user.', 'FORBIDDEN');
    return requestException(deps(), str(payload.conflictId, 'conflictId', { max: 64 }), payload.reason, actor);
  });
  return render(r, (c) => `Exception requested on conflict ${c.id}. The decision owner will review it; the plan stays blocked until then.`);
}

/**
 * Agents may draft decisions, never accept them: a decision drafted on someone's behalf stays
 * 'proposed' until its owner accepts it in the app.
 */
export async function draftDecision(payload: Payload, ctx?: RequestContext): Promise<string> {
  const actor = accountOf(ctx);
  const r = await safely(async () => {
    if (!actor) throw new DomainError('Could not identify the requesting user.', 'FORBIDDEN');
    let constraints: unknown;
    try {
      constraints = JSON.parse(str(payload.constraintsJson, 'constraintsJson', { max: 8000 }));
    } catch (e) {
      if (e instanceof DomainError) throw e;
      throw new DomainError('constraintsJson must be valid JSON.', 'INVALID');
    }
    const ownerAccountId = str(payload.ownerAccountId, 'ownerAccountId', { required: false, max: 128 }) || actor;
    const draft = {
      title: payload.title,
      statement: payload.statement,
      rationale: payload.rationale,
      ownerAccountId,
      enforcement: payload.enforcement ?? 'block',
      scope: { projectKeys: list(payload.projectKeys), labels: list(payload.labels), components: list(payload.components) },
      constraints,
      sourceUrl: payload.sourceUrl,
    };
    // Force proposal status even when the agent's user is the owner: a human confirms in the UI.
    const d = await createDecision(deps(), draft, `${actor}:agent`);
    return d;
  });
  return render(r, (d) => `Drafted decision ${d.id} "${d.title}" as PROPOSED. The owner must review and accept it in DecisionGraph before it is enforced.`);
}
