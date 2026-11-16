import { summarise } from '../domain/engine';
import type { ProposedAction } from '../domain/types';
import { fetchWorkItem, normaliseModifiedFields, notifyOwnerOnIssue, requiredFieldIds, statusName, forgeGraphSource } from '../adapters/jira';
import { refreshIssue, sweep } from '../services/graph';
import { runCheck, type CheckOutcome } from '../services/checks';
import { deps, failClosed } from './runtime';

const WATCHED_FIELDS = new Set(['summary', 'description', 'labels', 'Component', 'components']);

async function notifyNewConflicts(outcome: CheckOutcome): Promise<void> {
  const fresh = outcome.conflicts.filter((c) => c.receiptId === outcome.receipt.id && c.issueKey && c.status === 'open');
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
  // Keep the graph current for this issue on every create or edit (parent and links may have changed).
  try {
    await refreshIssue(deps(), forgeGraphSource, event.issue.key);
  } catch (e) {
    console.warn(`graph refresh failed for ${event.issue?.key}: ${(e as Error).message}`);
  }
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

interface IssueLinkEvent {
  eventType: string;
  issueLink?: { sourceIssueId?: string | number; destinationIssueId?: string | number };
}

/** avi:jira:created:issuelink / avi:jira:deleted:issuelink: refresh both ends of the link. */
export async function onIssueLinkEvent(event: IssueLinkEvent): Promise<void> {
  const ids = [event.issueLink?.sourceIssueId, event.issueLink?.destinationIssueId]
    .filter((x): x is string | number => x !== undefined && x !== null)
    .map(String)
    .filter((x) => /^\d+$/.test(x));
  for (const id of ids) {
    try {
      await refreshIssue(deps(), forgeGraphSource, id);
    } catch (e) {
      console.warn(`graph refresh failed for issue id ${id}: ${(e as Error).message}`);
    }
  }
}

/**
 * Daily (and on install) refresh of recently changed work. On install it looks back 30 days so the
 * graph is useful at once; daily runs look back 2 days. Marks the graph fresh only on full success.
 */
export async function graphSweep(event?: { eventType?: string }): Promise<void> {
  const installing = event?.eventType === 'avi:forge:installed:app';
  const r = await sweep(deps(), forgeGraphSource, { days: installing ? 30 : 2, cap: installing ? 1000 : 500 });
  console.log(`graph sweep: ${r.refreshed} refreshed, ${r.failed} failed`);
}
