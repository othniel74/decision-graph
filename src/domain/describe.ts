import type { Constraint, Decision, DecisionScope, FreezeWindow } from './types';

/**
 * Plain-English previews of rules and scopes, used in forms and decision cards.
 * Tolerant of half-filled input so the form can preview while someone types.
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function quoteList(items: string[] | undefined, joiner = 'or'): string {
  const xs = (items ?? []).map((s) => s.trim()).filter(Boolean).map((s) => `"${s}"`);
  if (xs.length === 0) return '…';
  if (xs.length === 1) return xs[0];
  return `${xs.slice(0, -1).join(', ')} ${joiner} ${xs[xs.length - 1]}`;
}

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

export function describeWindow(w: FreezeWindow | undefined): string {
  if (!w || !w.days?.length) return '';
  const days = [...w.days].sort().map((d) => DAY_NAMES[d] ?? '?').join(', ');
  const hours = w.fromHour === w.toHour ? 'all day' : `${hh(w.fromHour)}–${hh(w.toHour)}`;
  return ` on ${days}, ${hours} (${w.timezone})`;
}

export function describeScope(s: DecisionScope | undefined): string {
  if (!s) return 'issues in any project';
  const parts: string[] = [];
  parts.push(s.projectKeys?.length ? `issues in ${s.projectKeys.join(', ')}` : 'issues in any project');
  if (s.issueTypes?.length) parts.push(`of type ${s.issueTypes.join(' or ')}`);
  if (s.components?.length) parts.push(`in ${quoteList(s.components)}`);
  if (s.labels?.length) parts.push(`labelled ${quoteList(s.labels)}`);
  return parts.join(' ');
}

type PartialConstraint = Partial<Constraint> & { kind?: Constraint['kind'] } & Record<string, unknown>;

/** "Blocks issues in PAY that mention "store card" or "card number"". */
export function describeConstraint(c: PartialConstraint, scope?: DecisionScope, enforcement: 'warn' | 'block' = 'block'): string {
  const verb = enforcement === 'block' ? 'Blocks' : 'Warns on';
  const who = describeScope(scope);
  switch (c.kind) {
    case 'forbid_terms':
      return `${verb} ${who} that mention ${quoteList(c.terms as string[])}.`;
    case 'forbid_labels':
      return `${verb} ${who} carrying the label ${quoteList(c.labels as string[])}.`;
    case 'forbid_components':
      return `${verb} ${who} in the component ${quoteList(c.components as string[])}.`;
    case 'restrict_transition':
      return `${verb} moving ${who} to ${quoteList(c.toStatuses as string[])}${describeWindow(c.window as FreezeWindow | undefined)}.`;
    case 'require_field': {
      const label = (c.fieldLabel as string) || (c.field as string) || 'a field';
      return `${verb} moving ${who} to ${quoteList(c.whenEnteringStatuses as string[])} while "${label}" is empty.`;
    }
    default:
      return 'Choose a rule type.';
  }
}

export function describeDecisionRules(d: Pick<Decision, 'constraints' | 'scope' | 'enforcement'>): string[] {
  return d.constraints.map((c) => describeConstraint(c, d.scope, d.enforcement));
}
