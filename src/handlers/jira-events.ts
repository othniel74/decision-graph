import { summarise } from '../domain/engine';
import type { ProposedAction } from '../domain/types';
import { fetchWorkItem, normaliseModifiedFields, notifyOwnerOnIssue, requiredFieldIds, statusName } from '../adapters/jira';
import { runCheck, type CheckOutcome } from '../services/checks';
import { deps, failClosed } from './runtime';

const WATCHED_FIELDS = new Set(['summary', 'description', 'labels', 'Component', 'components']);

async function notifyNewConflicts(outcome: CheckOutcome): Promise<void> {
  const fresh = outcome.conflicts.filter((c) => c.receiptId === outcome.receipt.id && c.issueKey);
  for (const c of fresh) {
    const v = outcome.result.violations.find((x) => x.decisionId === c.decisionId);
    if (v && c.issueKey) await notifyOwnerOnIssue(c.issueKey, v.ownerAccountId, v.decisionTitle, v.message);
  }
}

interface ValidatorArgs {
  issue: { key: string };
  transition: { from?: { id: string }; to: { id: string } };
  modifiedFields?: Record<string, unknown>;
}

/**
 * jira:workflowValidator. Blocks a transition that breaks an accepted decision.
 * Runs on every transition it is attached to, so it fetches only the fields the decisions need.
 */
export async function validateTransition(args: ValidatorArgs, context?: { accountId?: string }): Promise<{ result: boolean; errorMessage?: string }> {
  try {
    const d = deps();
    const decisions = await d.store.listDecisions({ statuses: ['accepted'] });
    if (decisions.length === 0) return { result: true };
    const toStatus = await statusName(args.transition.to.id);
    const item = await fetchWorkItem(args.issue.key, requiredFieldIds(decisions), 'app', normaliseModifiedFields(args.modifiedFields));
    const action: ProposedAction = { type: 'transition', actorType: 'human', actorAccountId: context?.accountId, toStatus, item };
    const outcome = await runCheck(d, action, { decisions });
    if (outcome.receipt) await notifyNewConflicts(outcome as CheckOutcome);
    if (outcome.result.verdict === 'block') return { result: false, errorMessage: summarise(outcome.result).slice(0, 900) };
    return { result: true };
  } catch (e) {
    console.error('validateTransition failed', e);
    return failClosed()
      ? { result: false, errorMessage: 'DecisionGraph could not check this transition. Try again or contact your admin.' }
      : { result: true };
  }
}

interface IssueEvent {
  eventType: string;
  issue: { key: string };
  atlassianId?: string;
  changelog?: { items?: { field: string; fieldId?: string }[] };
}

/**
 * avi:jira:created:issue / avi:jira:updated:issue. Creating or editing an issue can't be blocked
 * by Forge, so conflicts are recorded and the owner is notified straight away.
 */
export async function onIssueEvent(event: IssueEvent): Promise<void> {
  const isCreate = event.eventType === 'avi:jira:created:issue';
  if (!isCreate) {
    const items = event.changelog?.items ?? [];
    if (!items.some((i) => WATCHED_FIELDS.has(i.field) || WATCHED_FIELDS.has(i.fieldId ?? ''))) return;
  }
  try {
    const d = deps();
    const decisions = await d.store.listDecisions({ statuses: ['accepted'] });
    if (decisions.length === 0) return;
    const item = await fetchWorkItem(event.issue.key, requiredFieldIds(decisions), 'app');
    const outcome = await runCheck(d, { type: isCreate ? 'create' : 'update', actorType: 'human', actorAccountId: event.atlassianId, item }, { decisions });
    if (outcome.receipt && outcome.result.verdict !== 'allow') await notifyNewConflicts(outcome as CheckOutcome);
  } catch (e) {
    console.error(`onIssueEvent failed for ${event.issue?.key}`, e);
  }
}
