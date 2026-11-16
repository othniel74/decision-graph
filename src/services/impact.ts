import { analyseImpact, scopeToJql, type ImpactReport } from '../domain/impact';
import { DomainError } from '../domain/lifecycle';
import { parseDecisionDraft } from '../domain/validate';
import type { Decision } from '../domain/types';
import { requiredFieldIds, type WorkSearch } from '../adapters/jira';
import type { Deps } from './context';

export const IMPACT_CAP = 200;

async function run(deps: Deps, search: WorkSearch, decision: Decision): Promise<ImpactReport & { jql: string }> {
  const jql = scopeToJql(decision.scope);
  const { items, truncated } = await search.search(jql, requiredFieldIds([decision]), IMPACT_CAP);
  const exceptions = await deps.store.listExceptions({ decisionId: decision.id });
  return { ...analyseImpact(decision, items, exceptions, deps.now(), truncated), jql };
}

/** Open work that contradicts a saved decision. */
export async function decisionImpact(deps: Deps, search: WorkSearch, decisionId: string) {
  const d = await deps.store.getDecision(decisionId);
  if (!d) throw new DomainError('Decision not found.', 'NOT_FOUND');
  return run(deps, search, d);
}

/** Preview: open work a draft decision would affect, before it is saved. Nothing is stored. */
export async function previewImpact(deps: Deps, search: WorkSearch, draftRaw: unknown) {
  const draft = parseDecisionDraft(draftRaw, deps.newId);
  const ts = deps.now().toISOString();
  return run(deps, search, { ...draft, id: 'preview', status: 'proposed', createdAt: ts, updatedAt: ts, version: 0 });
}
