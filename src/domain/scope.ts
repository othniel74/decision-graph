import type { Decision, DecisionScope, WorkItem } from './types';

const norm = (s: string): string => s.trim().toLowerCase();

function overlaps(required: string[], actual: string[]): boolean {
  if (required.length === 0) return true;
  const have = new Set(actual.map(norm));
  return required.some((r) => have.has(norm(r)));
}

function oneOf(required: string[], actual: string | undefined): boolean {
  if (required.length === 0) return true;
  if (actual === undefined) return false;
  const a = norm(actual);
  return required.some((r) => norm(r) === a);
}

/**
 * A decision applies when every non-empty scope dimension matches.
 * Within a dimension, any listed value is enough (labels and components are OR'd).
 */
export function scopeMatches(scope: DecisionScope, item: WorkItem): boolean {
  return (
    oneOf(scope.projectKeys, item.projectKey) &&
    oneOf(scope.issueTypes, item.issueType) &&
    overlaps(scope.components, item.components) &&
    overlaps(scope.labels, item.labels)
  );
}

/** Only accepted decisions are enforced. */
export function isEnforceable(d: Decision): boolean {
  return d.status === 'accepted';
}

export function applicableDecisions(decisions: Decision[], item: WorkItem): Decision[] {
  return decisions.filter((d) => isEnforceable(d) && scopeMatches(d.scope, item));
}

export const emptyScope = (): DecisionScope => ({
  projectKeys: [],
  issueTypes: [],
  components: [],
  labels: [],
});
