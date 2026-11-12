/**
 * Validation for untrusted input: UI forms, LLM-drafted constraints, agent payloads.
 * Hand-written to keep the Forge bundle small and errors user-readable.
 */
import { DomainError } from './lifecycle';
import type { Constraint, DecisionScope, Enforcement, FreezeWindow, TextField } from './types';

const MAX_TEXT = 4000;
const MAX_LIST = 50;
const TEXT_FIELDS: TextField[] = ['summary', 'description', 'proposal'];

function fail(msg: string): never {
  throw new DomainError(msg, 'INVALID');
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: unknown, name: string, opts: { required?: boolean; max?: number } = {}): string {
  const { required = true, max = MAX_TEXT } = opts;
  if (v === undefined || v === null || v === '') {
    if (required) fail(`${name} is required.`);
    return '';
  }
  if (typeof v !== 'string') fail(`${name} must be text.`);
  const s = v.trim();
  if (required && !s) fail(`${name} is required.`);
  if (s.length > max) fail(`${name} must be at most ${max} characters.`);
  return s;
}

export function strList(v: unknown, name: string, opts: { min?: number } = {}): string[] {
  if (v === undefined || v === null) v = [];
  if (!Array.isArray(v)) fail(`${name} must be a list.`);
  if (v.length > MAX_LIST) fail(`${name} can have at most ${MAX_LIST} entries.`);
  const out = [...new Set(v.map((x, i) => str(x, `${name}[${i}]`, { max: 200 })))];
  if (out.length < (opts.min ?? 0)) fail(`${name} needs at least ${opts.min} entr${opts.min === 1 ? 'y' : 'ies'}.`);
  return out;
}

function intIn(v: unknown, name: string, lo: number, hi: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) fail(`${name} must be a whole number from ${lo} to ${hi}.`);
  return v;
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function parseScope(v: unknown): DecisionScope {
  const o = isObj(v) ? v : {};
  return {
    projectKeys: strList(o.projectKeys, 'scope.projectKeys').map((k) => k.toUpperCase()),
    issueTypes: strList(o.issueTypes, 'scope.issueTypes'),
    components: strList(o.components, 'scope.components'),
    labels: strList(o.labels, 'scope.labels'),
  };
}

export function parseEnforcement(v: unknown): Enforcement {
  if (v === 'warn' || v === 'block') return v;
  fail('enforcement must be "warn" or "block".');
}

function parseWindow(v: unknown): FreezeWindow | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) fail('window must be an object.');
  const days = Array.isArray(v.days) ? v.days.map((d, i) => intIn(d, `window.days[${i}]`, 0, 6)) : fail('window.days must be a list.');
  if (days.length === 0) fail('window.days needs at least one day.');
  const timezone = str(v.timezone, 'window.timezone', { max: 64 });
  if (!validTimezone(timezone)) fail(`Unknown timezone "${timezone}".`);
  return {
    days: [...new Set(days)].sort(),
    fromHour: intIn(v.fromHour, 'window.fromHour', 0, 23),
    toHour: intIn(v.toHour, 'window.toHour', 0, 23),
    timezone,
  };
}

export function parseConstraint(v: unknown, id: string): Constraint {
  if (!isObj(v)) fail('Each constraint must be an object.');
  switch (v.kind) {
    case 'forbid_terms': {
      const fields = v.fields === undefined ? TEXT_FIELDS : strList(v.fields, 'fields', { min: 1 });
      for (const f of fields) if (!TEXT_FIELDS.includes(f as TextField)) fail(`Unknown text field "${f}".`);
      return { kind: 'forbid_terms', id, terms: strList(v.terms, 'terms', { min: 1 }), fields: fields as TextField[] };
    }
    case 'forbid_labels':
      return { kind: 'forbid_labels', id, labels: strList(v.labels, 'labels', { min: 1 }) };
    case 'forbid_components':
      return { kind: 'forbid_components', id, components: strList(v.components, 'components', { min: 1 }) };
    case 'restrict_transition':
      return {
        kind: 'restrict_transition',
        id,
        toStatuses: strList(v.toStatuses, 'toStatuses', { min: 1 }),
        window: parseWindow(v.window),
      };
    case 'require_field':
      return {
        kind: 'require_field',
        id,
        field: str(v.field, 'field', { max: 100 }),
        fieldLabel: str(v.fieldLabel ?? v.field, 'fieldLabel', { max: 100 }),
        whenEnteringStatuses: strList(v.whenEnteringStatuses, 'whenEnteringStatuses', { min: 1 }),
      };
    default:
      fail(`Unknown constraint kind "${String(v.kind)}".`);
  }
}

export interface DecisionDraft {
  title: string;
  statement: string;
  rationale: string;
  ownerAccountId: string;
  enforcement: Enforcement;
  scope: DecisionScope;
  constraints: Constraint[];
  sourceUrl?: string;
  sourcePageId?: string;
  reviewBy?: string;
}

/** Validate a decision draft. `newId` mints constraint ids so callers cannot inject their own. */
export function parseDecisionDraft(v: unknown, newId: () => string): DecisionDraft {
  if (!isObj(v)) fail('Decision must be an object.');
  const constraintsRaw = Array.isArray(v.constraints) ? v.constraints : fail('constraints must be a list.');
  if (constraintsRaw.length === 0) fail('A decision needs at least one constraint to be enforceable.');
  if (constraintsRaw.length > 20) fail('A decision can have at most 20 constraints.');
  const reviewBy = str(v.reviewBy, 'reviewBy', { required: false, max: 40 });
  if (reviewBy && Number.isNaN(Date.parse(reviewBy))) fail('reviewBy must be a date.');
  const sourceUrl = str(v.sourceUrl, 'sourceUrl', { required: false, max: 2000 });
  if (sourceUrl && !/^https:\/\//.test(sourceUrl)) fail('sourceUrl must be an https link.');
  return {
    title: str(v.title, 'title', { max: 200 }),
    statement: str(v.statement, 'statement'),
    rationale: str(v.rationale, 'rationale', { required: false }),
    ownerAccountId: str(v.ownerAccountId, 'ownerAccountId', { max: 128 }),
    enforcement: parseEnforcement(v.enforcement ?? 'block'),
    scope: parseScope(v.scope),
    constraints: constraintsRaw.map((c) => parseConstraint(c, newId())),
    sourceUrl: sourceUrl || undefined,
    sourcePageId: str(v.sourcePageId, 'sourcePageId', { required: false, max: 64 }) || undefined,
    reviewBy: reviewBy || undefined,
  };
}
