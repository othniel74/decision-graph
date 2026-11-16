import { describe, expect, it } from 'vitest';
import { check, reachOf, summarise } from '../src/domain/engine';
import { mentionsTerm } from '../src/domain/constraints';
import { emptyScope } from '../src/domain/scope';
import { transition, endTrial, startTrial } from '../src/domain/lifecycle';
import { parseDecisionDraft } from '../src/domain/validate';
import type { Connection } from '../src/domain/types';
import { action, decision, NOW, OWNER } from './fixtures';

const pageDecision = (over = {}) =>
  decision({ id: 'd-page', sourcePageId: '123', scope: emptyScope(), ...over });
const conn = (confirmed = false): Map<string, Connection> =>
  new Map([['d-page', { path: ['PAY-7', 'parent PAY-12', 'page "Payments Architecture"'], confirmed }]]);

describe('reach', () => {
  it('derives reach from page and scope', () => {
    expect(reachOf(decision())).toBe('scope');
    expect(reachOf(pageDecision())).toBe('connected');
    expect(reachOf(pageDecision({ scope: { ...emptyScope(), projectKeys: ['PAY'] } }))).toBe('both');
    expect(reachOf(pageDecision({ reach: 'scope' }))).toBe('scope');
  });
});

describe('connected matching', () => {
  const a = action({}, { projectKey: 'WEB', key: 'WEB-7', summary: 'Store card numbers' });

  it('does not apply a page decision without a connection', () => {
    expect(check({ action: a, decisions: [pageDecision()], exceptions: [], now: NOW }).applicableDecisionIds).toEqual([]);
  });

  it('applies through a connection but only warns until the path is confirmed', () => {
    const r = check({ action: a, decisions: [pageDecision()], exceptions: [], now: NOW, connections: conn() });
    expect(r.verdict).toBe('warn');
    expect(r.violations[0]).toMatchObject({ via: 'connected', capped: true, enforcement: 'warn' });
    expect(summarise(r)).toContain('applies via PAY-7 → parent PAY-12');
  });

  it('blocks through a confirmed path', () => {
    const r = check({ action: a, decisions: [pageDecision()], exceptions: [], now: NOW, connections: conn(true) });
    expect(r.verdict).toBe('block');
    expect(r.violations[0].capped).toBeUndefined();
  });

  it('prefers scope when both apply, keeping full enforcement', () => {
    const d = pageDecision({ scope: { ...emptyScope(), projectKeys: ['WEB'] } });
    const r = check({ action: a, decisions: [d], exceptions: [], now: NOW, connections: conn() });
    expect(r.violations[0]).toMatchObject({ via: 'scope', enforcement: 'block' });
  });

  it('a stale graph never makes a check stricter', () => {
    const r = check({ action: a, decisions: [pageDecision()], exceptions: [], now: NOW, connections: conn(true), graphStale: true });
    expect(r.verdict).toBe('allow');
    expect(r.graphStale).toBe(true);
  });

  it('a connection still needs a rule to fire', () => {
    const clean = action({}, { projectKey: 'WEB', key: 'WEB-8', summary: 'Add Apple Pay' });
    const r = check({ action: clean, decisions: [pageDecision()], exceptions: [], now: NOW, connections: conn(true) });
    expect(r.verdict).toBe('allow');
    expect(r.applicableDecisionIds).toEqual(['d-page']);
  });
});

describe('trial runs', () => {
  it('records conflicts as shadow while in trial and enforces after', () => {
    const d = decision({ trialUntil: '2026-12-10T00:00:00Z' });
    const a = action({}, { summary: 'store card' });
    const during = check({ action: a, decisions: [d], exceptions: [], now: NOW });
    expect(during.verdict).toBe('allow');
    expect(during.shadow).toHaveLength(1);
    const after = check({ action: a, decisions: [d], exceptions: [], now: new Date('2026-12-11T00:00:00Z') });
    expect(after.verdict).toBe('block');
    expect(after.shadow).toHaveLength(0);
  });

  it('starts at acceptance and the owner can end it early', () => {
    const proposed = decision({ status: 'proposed', trialDays: 7 });
    const accepted = transition(proposed, 'accepted', OWNER, NOW);
    expect(accepted.trialUntil).toBe('2026-12-11T15:00:00.000Z');
    expect(() => endTrial(accepted, 'someone', NOW)).toThrow(/owner/);
    const enforced = endTrial(accepted, OWNER, NOW);
    expect(Date.parse(enforced.trialUntil!)).toBe(NOW.getTime());
    expect(() => endTrial(enforced, OWNER, NOW)).toThrow(/not in a trial/);
    expect(startTrial(decision(), NOW).trialUntil).toBeUndefined();
  });

  it('validates trial length and reach', () => {
    const base = { title: 't', statement: 's', ownerAccountId: OWNER, constraints: [{ kind: 'forbid_labels', labels: ['x'] }] };
    expect(parseDecisionDraft({ ...base, trialDays: 7, reach: 'connected' }, () => 'c').trialDays).toBe(7);
    expect(() => parseDecisionDraft({ ...base, trialDays: 31 }, () => 'c')).toThrow(/trialDays/);
    expect(() => parseDecisionDraft({ ...base, reach: 'everywhere' }, () => 'c')).toThrow(/reach/);
  });
});

describe('negation-aware term matching', () => {
  it('ignores terms that the text rules out', () => {
    expect(mentionsTerm('We must not store card numbers anywhere', 'store card')).toBe(false);
    expect(mentionsTerm("Don't log the PAN", 'PAN')).toBe(false);
    expect(mentionsTerm('Use the vault without storing a card number', 'card number')).toBe(false);
    expect(mentionsTerm('Never, ever store card data', 'store card')).toBe(false);
  });
  it('still catches proposals, including after an earlier negated sentence', () => {
    expect(mentionsTerm('Store card numbers for repeat buyers', 'store card')).toBe(true);
    expect(mentionsTerm('We never logged it before. Now store card numbers in Redis.', 'store card')).toBe(true);
    expect(mentionsTerm('Do not cache it; store card details in the DB', 'store card')).toBe(true);
  });
  it('skips allowed phrases but not other mentions', () => {
    expect(mentionsTerm('Show the tokenised card number on receipts', 'card number', ['tokenised card number'])).toBe(false);
    expect(mentionsTerm('Show the tokenised card number and the full card number', 'card number', ['tokenised card number'])).toBe(true);
  });
  it('flows through the engine', () => {
    const r = check({ action: action({}, { summary: 'Checkout must never store card numbers' }), decisions: [decision()], exceptions: [], now: NOW });
    expect(r.verdict).toBe('allow');
  });
});
