import { DomainError } from '../domain/lifecycle';
import { strList } from '../domain/validate';
import type { Deps } from './context';
import { GRAPH_REFRESHED_KEY, STRONG_LINKS_KEY, graphPolicy } from './graph';

/**
 * Site-level settings. Teamwork Graph enrichment is OFF by default: the API is in
 * Early Access and its docs ask that apps calling it only be installed in test
 * organisations, so a Marketplace install must opt in explicitly.
 */
export const TWG_KEY = 'teamworkGraph.enabled';
export const INDEPENDENT_APPROVAL_KEY = 'approvals.independent';

export interface Settings {
  teamworkGraph: boolean;
  /** Issue link names that carry decisions across, e.g. "Blocks". Parent and page links always do. */
  strongIssueLinks: string[];
  /** Last full refresh of the decision graph (read-only). */
  graphRefreshedAt: string | null;
  /** Nobody approves an exception for a conflict they raised. On by default. */
  independentApproval: boolean;
}

export async function getSettings(deps: Deps): Promise<Settings> {
  const [twg, policy, refreshed, independent] = await Promise.all([
    deps.store.getSetting(TWG_KEY),
    graphPolicy(deps),
    deps.store.getSetting(GRAPH_REFRESHED_KEY),
    deps.store.getSetting(INDEPENDENT_APPROVAL_KEY),
  ]);
  return { teamworkGraph: twg === 'true', strongIssueLinks: policy.strongIssueLinks, graphRefreshedAt: refreshed, independentApproval: independent !== 'false' };
}

export async function updateSettings(deps: Deps, patch: unknown, isAdmin: boolean): Promise<Settings> {
  if (!isAdmin) throw new DomainError('Only Jira administrators can change DecisionGraph settings.', 'FORBIDDEN');
  const p = (typeof patch === 'object' && patch !== null ? patch : {}) as Record<string, unknown>;
  if ('teamworkGraph' in p) {
    if (typeof p.teamworkGraph !== 'boolean') throw new DomainError('teamworkGraph must be true or false.', 'INVALID');
    await deps.store.setSetting(TWG_KEY, String(p.teamworkGraph));
  }
  if ('independentApproval' in p) {
    if (typeof p.independentApproval !== 'boolean') throw new DomainError('independentApproval must be true or false.', 'INVALID');
    await deps.store.setSetting(INDEPENDENT_APPROVAL_KEY, String(p.independentApproval));
  }
  if ('strongIssueLinks' in p) {
    const names = strList(p.strongIssueLinks, 'strongIssueLinks').slice(0, 20);
    await deps.store.setSetting(STRONG_LINKS_KEY, JSON.stringify(names));
  }
  return getSettings(deps);
}
