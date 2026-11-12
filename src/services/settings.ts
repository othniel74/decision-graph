import { DomainError } from '../domain/lifecycle';
import type { Deps } from './context';

/**
 * Site-level settings. Teamwork Graph enrichment is OFF by default: the API is in
 * Early Access and its docs ask that apps calling it only be installed in test
 * organisations, so a Marketplace install must opt in explicitly.
 */
export const TWG_KEY = 'teamworkGraph.enabled';

export interface Settings {
  teamworkGraph: boolean;
}

export async function getSettings(deps: Deps): Promise<Settings> {
  return { teamworkGraph: (await deps.store.getSetting(TWG_KEY)) === 'true' };
}

export async function updateSettings(deps: Deps, patch: unknown, isAdmin: boolean): Promise<Settings> {
  if (!isAdmin) throw new DomainError('Only Jira administrators can change DecisionGraph settings.', 'FORBIDDEN');
  const p = (typeof patch === 'object' && patch !== null ? patch : {}) as Record<string, unknown>;
  if ('teamworkGraph' in p) {
    if (typeof p.teamworkGraph !== 'boolean') throw new DomainError('teamworkGraph must be true or false.', 'INVALID');
    await deps.store.setSetting(TWG_KEY, String(p.teamworkGraph));
  }
  return getSettings(deps);
}
