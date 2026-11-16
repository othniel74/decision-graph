import { analyseImpact, keysToJql, scopeToJql, type ImpactReport } from '../domain/impact';
import { reachOf } from '../domain/engine';
import { issuesReaching } from '../domain/graph';
import { DomainError } from '../domain/lifecycle';
import { parseDecisionDraft } from '../domain/validate';
import type { Connection, Decision, WorkItem } from '../domain/types';
import { requiredFieldIds, type WorkSearch } from '../adapters/jira';
import type { Deps } from './context';
import { graphPolicy, GRAPH_REFRESHED_KEY } from './graph';
import { graphIsFresh } from '../domain/graph';

export const IMPACT_CAP = 200;

export type ImpactResult = ImpactReport & { jql: string; connectedCount: number; graphStale: boolean };

async function run(deps: Deps, search: WorkSearch, decision: Decision): Promise<ImpactResult> {
  const reach = reachOf(decision);
  const fields = requiredFieldIds([decision]);
  const items = new Map<string, WorkItem>();
  let truncated = false;
  const queries: string[] = [];

  if (reach === 'scope' || reach === 'both') {
    const jql = scopeToJql(decision.scope);
    queries.push(jql);
    const r = await search.search(jql, fields, IMPACT_CAP);
    truncated ||= r.truncated;
    for (const it of r.items) if (it.key) items.set(it.key, it);
  }

  const connections = new Map<string, Connection>();
  let graphStale = false;
  if ((reach === 'connected' || reach === 'both') && decision.sourcePageId) {
    graphStale = !graphIsFresh(await deps.store.getSetting(GRAPH_REFRESHED_KEY), deps.now());
    if (!graphStale) {
      const policy = await graphPolicy(deps);
      const paths = await issuesReaching(decision.sourcePageId, (n) => deps.store.listEdgesTo(n), policy);
      const overrides = await deps.store.listOverrides({ decisionId: decision.id });
      for (const [key, path] of paths) {
        const o = overrides.find((x) => x.issueKey === key);
        if (o?.state === 'excluded') continue;
        connections.set(key, { path, confirmed: o?.state === 'confirmed' });
      }
      const jql = keysToJql([...connections.keys()]);
      if (jql) {
        queries.push(jql);
        const r = await search.search(jql, fields, IMPACT_CAP);
        truncated ||= r.truncated;
        for (const it of r.items) if (it.key && !items.has(it.key)) items.set(it.key, it);
      }
    }
  }

  const exceptions = await deps.store.listExceptions({ decisionId: decision.id });
  const report = analyseImpact(decision, [...items.values()], exceptions, deps.now(), truncated, connections);
  return { ...report, jql: queries.join(' | '), connectedCount: connections.size, graphStale };
}

/** Open work that contradicts a saved decision. */
export async function decisionImpact(deps: Deps, search: WorkSearch, decisionId: string): Promise<ImpactResult> {
  const d = await deps.store.getDecision(decisionId);
  if (!d) throw new DomainError('Decision not found.', 'NOT_FOUND');
  return run(deps, search, d);
}

/** Preview: open work a draft decision would affect, before it is saved. Nothing is stored. */
export async function previewImpact(deps: Deps, search: WorkSearch, draftRaw: unknown): Promise<ImpactResult> {
  const { trialDays: _t, ...draft } = parseDecisionDraft(draftRaw, deps.newId);
  const ts = deps.now().toISOString();
  return run(deps, search, { ...draft, id: 'preview', status: 'proposed', createdAt: ts, updatedAt: ts, version: 0 });
}
