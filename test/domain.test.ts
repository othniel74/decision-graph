import { describe, expect, it } from 'vitest';
import { check, summarise } from '../src/domain/engine';
import { containsTerm } from '../src/domain/constraints';
import { scopeMatches, emptyScope } from '../src/domain/scope';
import { inWindow } from '../src/domain/time';
import { supersede, transition, history, dueForReview, DomainError } from '../src/domain/lifecycle';
import { parseDecisionDraft } from '../src/domain/validate';
import { buildReceipt, verifyChain, type Receipt } from '../src/domain/receipt';
import { action, decision, NOW, OWNER } from './fixtures';

describe('containsTerm', () => {
  it('matches whole terms case-insensitively with flexible separators', () => {
    expect(containsTerm('We will Store-Card data', 'store card')).toBe(true);
    expect(containsTerm('log the PAN for debugging', 'PAN')).toBe(true);
  });
  it('does not match inside other words', () => {
    expect(containsTerm('expand the panel', 'PAN')).toBe(false);
    expect(containsTerm('', 'PAN')).toBe(false);
    expect(containsTerm('anything', '  ')).toBe(false);
  });
  it('treats regex characters in terms literally', () => {
    expect(containsTerm('use a.b now', 'a.b')).toBe(true);
    expect(containsTerm('use axb now', 'a.b')).toBe(false);
  });
});

describe('scopeMatches', () => {
  it('treats empty dimensions as any and ORs values within a dimension', () => {
    const s = { ...emptyScope(), projectKeys: ['PAY'], labels: ['pci', 'payments'] };
    expect(scopeMatches(s, action({}, { labels: ['Payments'] }).item)).toBe(true);
    expect(scopeMatches(s, action({}, { labels: ['ui'] }).item)).toBe(false);
    expect(scopeMatches(s, action({}, { projectKey: 'WEB', labels: ['pci'] }).item)).toBe(false);
  });
});

describe('check', () => {
  it('blocks text that contradicts an accepted decision, with evidence', () => {
    const r = check({ action: action({}, { summary: 'Store card numbers to speed up checkout' }), decisions: [decision()], exceptions: [], now: NOW });
    expect(r.verdict).toBe('block');
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].evidence[0]).toContain('store card');
    expect(r.violations[0].sourceUrl).toBeDefined();
    expect(summarise(r)).toMatch(/^Blocked/);
  });

  it('allows unrelated work and work outside scope', () => {
    expect(check({ action: action(), decisions: [decision()], exceptions: [], now: NOW }).verdict).toBe('allow');
    const outside = action({}, { projectKey: 'WEB', summary: 'store card numbers' });
    const r = check({ action: outside, decisions: [decision()], exceptions: [], now: NOW });
    expect(r.verdict).toBe('allow');
    expect(r.applicableDecisionIds).toEqual([]);
  });

  it('ignores decisions that are not accepted', () => {
    for (const status of ['proposed', 'superseded', 'deprecated', 'rejected'] as const) {
      const r = check({ action: action({}, { summary: 'store card' }), decisions: [decision({ status })], exceptions: [], now: NOW });
      expect(r.verdict).toBe('allow');
    }
  });

  it('warn-level decisions produce warn, block wins over warn', () => {
    const warnD = decision({ id: 'd-warn', enforcement: 'warn' });
    expect(check({ action: action({}, { summary: 'store card' }), decisions: [warnD], exceptions: [], now: NOW }).verdict).toBe('warn');
    expect(check({ action: action({}, { summary: 'store card' }), decisions: [warnD, decision()], exceptions: [], now: NOW }).verdict).toBe('block');
  });

  it('honours a live owner exception for the same issue and records it as waived', () => {
    const ex = { id: 'x1', decisionId: 'd-card', issueKey: 'PAY-42', grantedByAccountId: OWNER, reason: 'Tokenised test data only', createdAt: NOW.toISOString() };
    const r = check({ action: action({}, { summary: 'store card' }), decisions: [decision()], exceptions: [ex], now: NOW });
    expect(r.verdict).toBe('allow');
    expect(r.waived[0].exceptionId).toBe('x1');
  });

  it('does not honour expired exceptions or exceptions for other issues', () => {
    const base = { id: 'x1', decisionId: 'd-card', grantedByAccountId: OWNER, reason: 'r', createdAt: NOW.toISOString() };
    const expired = { ...base, issueKey: 'PAY-42', expiresAt: '2026-12-01T00:00:00Z' };
    const other = { ...base, issueKey: 'PAY-7' };
    const r = check({ action: action({}, { summary: 'store card' }), decisions: [decision()], exceptions: [expired, other], now: NOW });
    expect(r.verdict).toBe('block');
  });

  it('agent proposals without an issue key cannot use exceptions', () => {
    const ex = { id: 'x1', decisionId: 'd-card', issueKey: 'PAY-42', grantedByAccountId: OWNER, reason: 'r', createdAt: NOW.toISOString() };
    const a = action({ type: 'proposal', actorType: 'rovo_agent' }, { key: undefined, proposal: 'I will store card details in Redis' });
    expect(check({ action: a, decisions: [decision()], exceptions: [ex], now: NOW }).verdict).toBe('block');
  });

  it('restricts transitions only inside the freeze window', () => {
    const freeze = decision({
      id: 'd-freeze',
      title: 'No Friday afternoon deploys',
      constraints: [{ kind: 'restrict_transition', id: 'c2', toStatuses: ['Deployed'], window: { days: [5], fromHour: 12, toHour: 23, timezone: 'Europe/London' } }],
    });
    const deploy = action({ type: 'transition', toStatus: 'deployed' });
    expect(check({ action: deploy, decisions: [freeze], exceptions: [], now: NOW }).verdict).toBe('block');
    expect(check({ action: deploy, decisions: [freeze], exceptions: [], now: new Date('2026-12-03T15:00:00Z') }).verdict).toBe('allow');
    expect(check({ action: action({ type: 'transition', toStatus: 'In Review' }), decisions: [freeze], exceptions: [], now: NOW }).verdict).toBe('allow');
  });

  it('requires a field before entering a status', () => {
    const d = decision({
      id: 'd-sec',
      constraints: [{ kind: 'require_field', id: 'c3', field: 'customfield_1', fieldLabel: 'Security review', whenEnteringStatuses: ['Done'] }],
    });
    const done = (fields: Record<string, unknown>) => action({ type: 'transition', toStatus: 'Done' }, { fields });
    expect(check({ action: done({}), decisions: [d], exceptions: [], now: NOW }).violations[0].message).toContain('Security review');
    expect(check({ action: done({ customfield_1: '  ' }), decisions: [d], exceptions: [], now: NOW }).verdict).toBe('block');
    expect(check({ action: done({ customfield_1: 'SEC-9' }), decisions: [d], exceptions: [], now: NOW }).verdict).toBe('allow');
  });

  it('flags forbidden labels and components', () => {
    const d = decision({
      id: 'd-lab',
      constraints: [
        { kind: 'forbid_labels', id: 'c4', labels: ['raw-pan'] },
        { kind: 'forbid_components', id: 'c5', components: ['Legacy Vault'] },
      ],
    });
    const r = check({ action: action({}, { labels: ['RAW-PAN'], components: ['legacy vault'] }), decisions: [d], exceptions: [], now: NOW });
    expect(r.violations.map((v) => v.constraintKind)).toEqual(['forbid_labels', 'forbid_components']);
  });
});

describe('freeze windows', () => {
  it('handles windows that wrap midnight', () => {
    const w = { days: [5], fromHour: 18, toHour: 6, timezone: 'Europe/London' };
    expect(inWindow(w, new Date('2026-12-04T19:00:00Z'))).toBe(true); // Fri 19:00
    expect(inWindow(w, new Date('2026-12-05T03:00:00Z'))).toBe(true); // Sat 03:00
    expect(inWindow(w, new Date('2026-12-05T07:00:00Z'))).toBe(false); // Sat 07:00
    expect(inWindow(w, new Date('2026-12-04T17:00:00Z'))).toBe(false); // Fri 17:00
  });
  it('respects timezones', () => {
    const w = { days: [5], fromHour: 9, toHour: 17, timezone: 'America/New_York' };
    expect(inWindow(w, new Date('2026-12-04T15:00:00Z'))).toBe(true); // 10:00 NY
    expect(inWindow(w, new Date('2026-12-04T23:00:00Z'))).toBe(false); // 18:00 NY
  });
});

describe('lifecycle', () => {
  it('only the owner can change status, along allowed paths', () => {
    expect(() => transition(decision(), 'deprecated', 'someone-else', NOW)).toThrow(DomainError);
    expect(() => transition(decision(), 'accepted', OWNER, NOW)).toThrow(/cannot become/);
    expect(transition(decision({ status: 'proposed' }), 'accepted', OWNER, NOW).version).toBe(2);
  });

  it('supersede links both records and history walks the chain', () => {
    const old = decision();
    const next = decision({ id: 'd-card-2', status: 'proposed', title: 'Card storage only via vault tokens' });
    const res = supersede(old, next, OWNER, NOW);
    expect(res.old.status).toBe('superseded');
    expect(res.old.supersededById).toBe('d-card-2');
    expect(res.replacement.status).toBe('accepted');
    const byId = new Map([res.old, res.replacement].map((d) => [d.id, d]));
    expect(history('d-card-2', byId).map((d) => d.id)).toEqual(['d-card-2', 'd-card']);
  });

  it('lists decisions due for review', () => {
    const due = decision({ reviewBy: '2026-11-01' });
    expect(dueForReview([due, decision({ id: 'x' })], NOW).map((d) => d.id)).toEqual(['d-card']);
  });
});

describe('parseDecisionDraft', () => {
  let n = 0;
  const id = () => `c-${++n}`;
  const valid = {
    title: 'No Friday deploys',
    statement: 'We do not deploy on Friday afternoons.',
    ownerAccountId: OWNER,
    scope: { projectKeys: ['pay'] },
    constraints: [{ kind: 'restrict_transition', toStatuses: ['Deployed'], window: { days: [5], fromHour: 12, toHour: 23, timezone: 'Europe/London' } }],
  };

  it('accepts a valid draft, normalises keys and mints constraint ids', () => {
    const d = parseDecisionDraft({ ...valid, constraints: [{ ...valid.constraints[0], id: 'attacker-id' }] }, id);
    expect(d.scope.projectKeys).toEqual(['PAY']);
    expect(d.enforcement).toBe('block');
    expect(d.constraints[0].id).toMatch(/^c-/);
  });

  it('rejects bad input with readable messages', () => {
    expect(() => parseDecisionDraft({ ...valid, constraints: [] }, id)).toThrow(/at least one constraint/);
    expect(() => parseDecisionDraft({ ...valid, constraints: [{ kind: 'run_code' }] }, id)).toThrow(/Unknown constraint/);
    expect(() => parseDecisionDraft({ ...valid, title: 42 }, id)).toThrow(/title must be text/);
    expect(() => parseDecisionDraft({ ...valid, sourceUrl: 'javascript:alert(1)' }, id)).toThrow(/https/);
    const badTz = { ...valid, constraints: [{ ...valid.constraints[0], window: { days: [5], fromHour: 1, toHour: 2, timezone: 'Mars/Base' } }] };
    expect(() => parseDecisionDraft(badTz, id)).toThrow(/Unknown timezone/);
    const badHour = { ...valid, constraints: [{ ...valid.constraints[0], window: { days: [5], fromHour: 24, toHour: 2, timezone: 'UTC' } }] };
    expect(() => parseDecisionDraft(badHour, id)).toThrow(/fromHour/);
  });
});

describe('receipts', () => {
  function chain(n: number): Receipt[] {
    const out: Receipt[] = [];
    for (let i = 0; i < n; i++) {
      const a = action({}, { summary: i % 2 ? 'store card' : 'fine' });
      const r = check({ action: a, decisions: [decision()], exceptions: [], now: NOW });
      out.push(buildReceipt(a, r, out.at(-1) ?? null, `r${i}`));
    }
    return out;
  }

  it('builds a verifiable hash chain', () => {
    const c = chain(5);
    expect(c[0].sequence).toBe(1);
    expect(c[4].prevHash).toBe(c[3].hash);
    expect(verifyChain(c)).toBeNull();
    expect(verifyChain(c.slice(2))).toBeNull();
  });

  it('detects tampering, deletion and reordering', () => {
    const tampered = chain(4);
    tampered[1] = { ...tampered[1], verdict: 'allow' };
    expect(verifyChain(tampered)).toBe(2);
    const deleted = chain(4);
    deleted.splice(2, 1);
    expect(verifyChain(deleted)).toBe(4);
    const reordered = chain(3);
    [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
    expect(verifyChain(reordered)).not.toBeNull();
  });
});
