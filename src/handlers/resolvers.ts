import Resolver from '@forge/resolver';
import { DomainError } from '../domain/lifecycle';
import { str } from '../domain/validate';
import type { DecisionStatus } from '../domain/types';
import { fetchWorkItem, requiredFieldIds, isJiraAdmin, forgeDemoJira, forgeWorkSearch, forgeGraphSource } from '../adapters/jira';
import { refreshNeighbourhood, setPathOverride, reportsForOwner } from '../services/graph';
import { enforceNow } from '../services/decisions';
import { decisionImpact, previewImpact } from '../services/impact';
import { ownerTeams, pageOwnerAccountIds } from '../adapters/teamwork-graph';
import { runCheck } from '../services/checks';
import { changeStatus, createDecision, getDecisionWithHistory, listDecisions, supersedeDecision, decisionsDueForReview } from '../services/decisions';
import { myReviewQueue, requestException, resolveConflict, type Resolution } from '../services/reviews';
import { health, verifyAuditTrail } from '../services/audit';
import { getSettings, updateSettings } from '../services/settings';
import { demoLoaded, seedDemo } from '../services/demo';
import { deps, safely } from './runtime';

/**
 * Backend for the UI Kit surfaces. The caller's identity always comes from the Forge
 * context (never from the payload), so ownership checks can't be spoofed by the frontend.
 */

interface Ctx {
  accountId?: string;
  extension?: { issue?: { key?: string }; content?: { id?: string }; space?: { key?: string } };
  cloudId?: string;
}
type Req = { payload: Record<string, unknown>; context: Ctx };

function actor(ctx: Ctx): string {
  if (!ctx.accountId) throw new DomainError('You need to be signed in.', 'FORBIDDEN');
  return ctx.accountId;
}

const STATUSES: DecisionStatus[] = ['proposed', 'accepted', 'superseded', 'deprecated', 'rejected'];

const resolver = new Resolver();

resolver.define('whoami', async ({ context }: Req) => safely(async () => ({ accountId: actor(context) })));

/** Issue panel: what applies, what conflicts (preview, not recorded), open conflicts, owner teams. */
resolver.define('issuePanel', async ({ context }: Req) =>
  safely(async () => {
    const me = actor(context);
    const key = context.extension?.issue?.key;
    if (!key) throw new DomainError('No issue in context.', 'INVALID');
    const d = deps();
    // Bring this issue's links up to date so the "why this applies" path is current.
    try {
      await refreshNeighbourhood(d, forgeGraphSource, key);
    } catch (e) {
      console.warn(`panel graph refresh failed for ${key}: ${(e as Error).message}`);
    }
    const all = await d.store.listDecisions({ statuses: ['accepted'] });
    const item = await fetchWorkItem(key, requiredFieldIds(all), 'user');
    const preview = await runCheck(d, { type: 'update', actorType: 'human', actorAccountId: me, item }, { record: false, decisions: all });
    const [conflicts, exceptions, overrides] = await Promise.all([
      d.store.listConflicts({ issueKey: key, limit: 20 }),
      d.store.listExceptions({ issueKey: key }),
      d.store.listOverrides({ issueKey: key }),
    ]);
    const applicable = all.filter((x) => preview.result.applicableDecisionIds.includes(x.id));
    const owners = [...new Set(preview.result.violations.map((v) => v.ownerAccountId))].slice(0, 3);
    const twg = (await getSettings(d)).teamworkGraph;
    const teams = twg ? Object.fromEntries(await Promise.all(owners.map(async (o) => [o, await ownerTeams(o)] as const))) : {};
    return {
      me,
      issueKey: key,
      result: preview.result,
      applicable,
      conflicts: conflicts.filter((c) => c.status !== 'shadow'),
      exceptions,
      overrides,
      ownerTeams: teams,
    };
  }),
);

resolver.define('listDecisions', async ({ payload }: Req) =>
  safely(async () => {
    const statuses = Array.isArray(payload.statuses) ? payload.statuses.filter((s): s is DecisionStatus => STATUSES.includes(s as DecisionStatus)) : undefined;
    const ownerAccountId = str(payload.ownerAccountId, 'ownerAccountId', { required: false, max: 128 }) || undefined;
    return listDecisions(deps(), { statuses, ownerAccountId });
  }),
);

resolver.define('getDecision', async ({ payload }: Req) => safely(async () => getDecisionWithHistory(deps(), str(payload.id, 'id', { max: 64 }))));

resolver.define('createDecision', async ({ payload, context }: Req) => safely(async () => createDecision(deps(), payload.draft, actor(context))));

resolver.define('changeStatus', async ({ payload, context }: Req) =>
  safely(async () => {
    const to = payload.to;
    if (to !== 'accepted' && to !== 'rejected' && to !== 'deprecated') throw new DomainError('Unsupported status change.', 'INVALID');
    return changeStatus(deps(), str(payload.id, 'id', { max: 64 }), to, actor(context));
  }),
);

resolver.define('supersede', async ({ payload, context }: Req) =>
  safely(async () => supersedeDecision(deps(), str(payload.id, 'id', { max: 64 }), payload.draft, actor(context))),
);

resolver.define('requestException', async ({ payload, context }: Req) =>
  safely(async () => requestException(deps(), str(payload.conflictId, 'conflictId', { max: 64 }), payload.note, actor(context))),
);

resolver.define('resolveConflict', async ({ payload, context }: Req) =>
  safely(async () => {
    const resolution = payload.resolution as Resolution;
    if (!['uphold', 'grant_exception', 'withdraw'].includes(resolution)) throw new DomainError('Unknown resolution.', 'INVALID');
    return resolveConflict(
      deps(),
      { conflictId: str(payload.conflictId, 'conflictId', { max: 64 }), resolution, note: payload.note, expiresAt: payload.expiresAt },
      actor(context),
    );
  }),
);

resolver.define('reviewQueue', async ({ context }: Req) =>
  safely(async () => {
    const me = actor(context);
    const [conflicts, reports] = await Promise.all([myReviewQueue(deps(), me), reportsForOwner(deps(), me)]);
    return { conflicts, reports };
  }),
);

/** Owner confirms or excludes a connected path for one issue; anyone may report it as not relevant. */
resolver.define('setPathOverride', async ({ payload, context }: Req) =>
  safely(async () => setPathOverride(deps(), { decisionId: payload.decisionId, issueKey: payload.issueKey, state: payload.state, note: payload.note }, actor(context))),
);

/** Owner ends a decision's trial run; enforcement starts now. */
resolver.define('enforceNow', async ({ payload, context }: Req) => safely(async () => enforceNow(deps(), str(payload.id, 'id', { max: 64 }), actor(context))));

/** What a decision in its trial run would have flagged so far. */
resolver.define('trialHits', async ({ payload, context }: Req) =>
  safely(async () => {
    actor(context);
    return deps().store.listConflicts({ status: 'shadow', ownerDecisionIds: [str(payload.id, 'id', { max: 64 })], limit: 50 });
  }),
);

resolver.define('health', async () =>
  safely(async () => ({ summary: await health(deps()), dueForReview: await decisionsDueForReview(deps()) })),
);

resolver.define('verifyAudit', async () => safely(async () => verifyAuditTrail(deps())));

resolver.define('recentReceipts', async () =>
  safely(async () => {
    const d = deps();
    const latest = await d.store.latestReceipt();
    if (!latest) return [];
    const rows = await d.store.listReceipts({ fromSequence: Math.max(1, latest.sequence - 24), limit: 25 });
    return rows.reverse();
  }),
);

/** Confluence macro: decisions recorded on this page, plus a suggested owner from Teamwork Graph. */
resolver.define('pageDecisions', async ({ context }: Req) =>
  safely(async () => {
    const me = actor(context);
    const pageId = context.extension?.content?.id;
    if (!pageId) throw new DomainError('No page in context.', 'INVALID');
    const decisions = await listDecisions(deps(), { sourcePageId: pageId });
    const twg = (await getSettings(deps())).teamworkGraph;
    const owners = twg && context.cloudId ? await pageOwnerAccountIds(`ari:cloud:confluence:${context.cloudId}:page/${pageId}`) : [];
    return { me, pageId, decisions, suggestedOwner: owners[0] ?? me };
  }),
);

/** Setup tab: settings, admin status and whether demo data is loaded. */
resolver.define('setup', async ({ context }: Req) =>
  safely(async () => {
    actor(context);
    const [settings, isAdmin, demo] = await Promise.all([getSettings(deps()), isJiraAdmin(), demoLoaded(deps())]);
    return { settings, isAdmin, demoLoaded: demo };
  }),
);

resolver.define('updateSettings', async ({ payload, context }: Req) =>
  safely(async () => {
    actor(context);
    return updateSettings(deps(), payload.patch, await isJiraAdmin());
  }),
);

resolver.define('seedDemo', async ({ payload, context }: Req) =>
  safely(async () => seedDemo(deps(), forgeDemoJira, { projectKey: payload.projectKey, isAdmin: await isJiraAdmin() }, actor(context))),
);

/** Open work that already contradicts a saved decision (runs as the user). */
resolver.define('decisionImpact', async ({ payload, context }: Req) =>
  safely(async () => {
    actor(context);
    return decisionImpact(deps(), forgeWorkSearch, str(payload.id, 'id', { max: 64 }));
  }),
);

/** What a draft decision would affect, before saving. Stores nothing. */
resolver.define('previewImpact', async ({ payload, context }: Req) =>
  safely(async () => {
    actor(context);
    return previewImpact(deps(), forgeWorkSearch, payload.draft);
  }),
);

export const handler = resolver.getDefinitions();
