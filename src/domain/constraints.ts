import type { Constraint, ProposedAction, TextField, WorkItem } from './types';
import { inWindow } from './time';

export interface ConstraintHit {
  message: string;
  evidence: string[];
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const norm = (s: string): string => s.trim().toLowerCase();

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termRegex(term: string, flags: string): RegExp | null {
  const t = term.trim();
  if (!t) return null;
  const body = t.split(/\s+/).map(escapeRegex).join('[\\s\\-_]+');
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${body})(?=$|[^\\p{L}\\p{N}])`, flags);
}

/** Case-insensitive whole-term match that treats any run of whitespace in the term as flexible. */
export function containsTerm(text: string, term: string): boolean {
  return termRegex(term, 'iu')?.test(text) ?? false;
}

/** Words that, just before a term, mean the text rules it out rather than proposes it. */
const NEGATORS = new Set([
  'not', 'never', 'no', "don't", 'dont', "doesn't", "won't", "mustn't", "shouldn't", 'cannot', "can't",
  'avoid', 'avoids', 'avoiding', 'without', 'prohibit', 'prohibits', 'prohibited', 'forbid', 'forbids', 'forbidden',
  'stop', 'stops', 'remove', 'removes', 'removing', 'instead',
]);
const NEGATION_WINDOW = 3;

function negatedAt(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 60), index).toLowerCase().replace(/[’]/g, "'");
  // A sentence boundary resets the window: "We never log it. Store card numbers." is not negated.
  const clause = before.split(/[.!?;\n]/).pop() ?? '';
  const words = clause.split(/[^\p{L}\p{N}']+/u).filter(Boolean).slice(-NEGATION_WINDOW);
  return words.some((w) => NEGATORS.has(w));
}

function stripAllowed(text: string, allow: string[] | undefined): string {
  let out = text;
  for (const phrase of allow ?? []) {
    const re = termRegex(phrase, 'giu');
    if (re) out = out.replace(re, (_m, lead: string) => `${lead} `);
  }
  return out;
}

/**
 * True when the text proposes the term: a whole-term match that is not inside an allowed phrase
 * and not just after a negation ("we must not store card numbers" does not count).
 */
export function mentionsTerm(text: string, term: string, allow?: string[]): boolean {
  const cleaned = stripAllowed(text, allow);
  const re = termRegex(term, 'giu');
  if (!re) return false;
  for (const m of cleaned.matchAll(re)) {
    const start = (m.index ?? 0) + m[1].length;
    if (!negatedAt(cleaned, start)) return true;
  }
  return false;
}

function textOf(item: WorkItem, field: TextField): string {
  return item[field] ?? '';
}

function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function targetStatus(action: ProposedAction): string | undefined {
  return action.type === 'transition' || action.type === 'proposal' ? action.toStatus : undefined;
}

function describeWindow(c: Extract<Constraint, { kind: 'restrict_transition' }>): string {
  if (!c.window) return '';
  const w = c.window;
  const days = w.days.map((d) => DAY_NAMES[d]).join(', ');
  const hours = w.fromHour === w.toHour ? 'all day' : `${String(w.fromHour).padStart(2, '0')}:00-${String(w.toHour).padStart(2, '0')}:00`;
  return ` during the freeze window (${days}, ${hours} ${w.timezone})`;
}

/** Evaluate one constraint. Returns null when the action does not conflict with it. */
export function evaluateConstraint(c: Constraint, action: ProposedAction, now: Date): ConstraintHit | null {
  const item = action.item;
  switch (c.kind) {
    case 'forbid_terms': {
      const found: string[] = [];
      for (const term of c.terms) {
        for (const field of c.fields) {
          if (mentionsTerm(textOf(item, field), term, c.allow)) {
            found.push(`"${term}" in ${field}`);
            break;
          }
        }
      }
      return found.length
        ? { message: `Mentions something this decision rules out: ${found.join(', ')}.`, evidence: found }
        : null;
    }
    case 'forbid_labels': {
      const forbidden = new Set(c.labels.map(norm));
      const found = item.labels.filter((l) => forbidden.has(norm(l)));
      return found.length
        ? { message: `Carries label(s) this decision rules out: ${found.join(', ')}.`, evidence: found.map((l) => `label:${l}`) }
        : null;
    }
    case 'forbid_components': {
      const forbidden = new Set(c.components.map(norm));
      const found = item.components.filter((x) => forbidden.has(norm(x)));
      return found.length
        ? { message: `Is in component(s) this decision rules out: ${found.join(', ')}.`, evidence: found.map((x) => `component:${x}`) }
        : null;
    }
    case 'restrict_transition': {
      const to = targetStatus(action);
      if (!to) return null;
      if (!c.toStatuses.some((s) => norm(s) === norm(to))) return null;
      if (c.window && !inWindow(c.window, now)) return null;
      return {
        message: `Moving to "${to}" is restricted by this decision${describeWindow(c)}.`,
        evidence: [`status:${to}`, ...(c.window ? [`at:${now.toISOString()}`] : [])],
      };
    }
    case 'require_field': {
      const to = targetStatus(action);
      if (!to || !c.whenEnteringStatuses.some((s) => norm(s) === norm(to))) return null;
      if (!isEmptyValue(item.fields[c.field])) return null;
      return {
        message: `"${c.fieldLabel}" must be filled in before moving to "${to}".`,
        evidence: [`missing:${c.field}`],
      };
    }
  }
}
