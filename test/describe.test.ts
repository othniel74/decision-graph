import { describe, expect, it } from 'vitest';
import { describeConstraint, describeScope, describeDecisionRules } from '../src/domain/describe';
import { emptyScope } from '../src/domain/scope';
import { decision } from './fixtures';

describe('rule previews', () => {
  const pay = { ...emptyScope(), projectKeys: ['PAY'] };
  it('describes each rule kind in plain English', () => {
    expect(describeConstraint({ kind: 'forbid_terms', terms: ['store card', 'card number'] }, pay)).toBe(
      'Blocks issues in PAY that mention "store card" or "card number". Mentions that rule it out, like "must not store card", are ignored.',
    );
    expect(describeConstraint({ kind: 'forbid_labels', labels: ['skip-review'] }, pay, 'warn')).toBe('Warns on issues in PAY carrying the label "skip-review".');
    expect(describeConstraint({ kind: 'forbid_components', components: ['Legacy'] })).toBe('Blocks issues in any project in the component "Legacy".');
    expect(describeConstraint({ kind: 'restrict_transition', toStatuses: ['Done', 'Deployed'], window: { days: [5], fromHour: 12, toHour: 23, timezone: 'Europe/London' } }, pay))
      .toBe('Blocks moving issues in PAY to "Done" or "Deployed" on Fri, 12:00–23:00 (Europe/London).');
    expect(describeConstraint({ kind: 'require_field', field: 'customfield_1', fieldLabel: 'Security review', whenEnteringStatuses: ['Done'] }, pay))
      .toBe('Blocks moving issues in PAY to "Done" while "Security review" is empty.');
  });
  it('tolerates half-filled input', () => {
    expect(describeConstraint({ kind: 'forbid_terms', terms: [] })).toBe('Blocks issues in any project that mention ….');
    expect(describeConstraint({ kind: 'forbid_terms', terms: ['PAN'], allow: ['tokenised PAN'] })).toContain('Allowed: "tokenised PAN".');
    expect(describeConstraint({})).toBe('Choose a rule type.');
    expect(describeConstraint({ kind: 'restrict_transition', toStatuses: ['Done'], window: { days: [], fromHour: 0, toHour: 0, timezone: 'UTC' } })).toBe('Blocks moving issues in any project to "Done".');
  });
  it('describes scopes and whole decisions', () => {
    expect(describeScope({ projectKeys: ['PAY', 'WEB'], issueTypes: ['Story'], components: [], labels: ['pci'] })).toBe('issues in PAY, WEB of type Story labelled "pci"');
    expect(describeDecisionRules(decision())[0]).toMatch(/^Blocks issues in PAY that mention "store card", "card number" or "PAN"\./);
  });
  it('mentions linked work for decisions recorded on a page', () => {
    const both = decision({ sourcePageId: '1' });
    expect(describeDecisionRules(both)[0]).toMatch(/^Blocks issues in PAY, and work linked to this page, that mention/);
    const linkedOnly = decision({ sourcePageId: '1', scope: emptyScope() });
    expect(describeDecisionRules(linkedOnly)[0]).toMatch(/^Blocks work linked to this page that mention/);
    const moved = describeConstraint({ kind: 'restrict_transition', toStatuses: ['Done'] }, pay, 'warn', { linked: true });
    expect(moved).toBe('Warns on moving issues in PAY, and work linked to this page, to "Done".');
  });
});
