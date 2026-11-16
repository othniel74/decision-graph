import { describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({ default: {}, route: () => '' }));

import { analyseImpact, jqlString, scopeToJql } from '../src/domain/impact';
import { emptyScope } from '../src/domain/scope';
import { MemoryStore } from '../src/storage/memory';
import { decisionImpact, previewImpact } from '../src/services/impact';
import type { WorkSearch } from '../src/adapters/jira';
import type { WorkItem } from '../src/domain/types';
import { decision, item, NOW, OWNER } from './fixtures';

const open: WorkItem[] = [
  item({ key: 'PAY-3', summary: 'Store card numbers for repeat buyers', status: 'To Do' }),
  item({ key: 'PAY-10', summary: 'Log the PAN on failure', status: 'In Progress' }),
  item({ key: 'PAY-2', summary: 'Add Apple Pay', status: 'To Do' }),
];

describe('analyseImpact', () => {
  it('lists only contradicting work, sorted, with reasons', () => {
    const r = analyseImpact(decision(), open, [], NOW);
    expect(r.scanned).toBe(3);
    expect(r.affected.map((a) => a.key)).toEqual(['PAY-3', 'PAY-10']);
    expect(r.affected[0].violations[0].message).toMatch(/store card/);
  });
  it('marks excepted issues as waived and sorts them last', () => {
    const ex = { id: 'x', decisionId: 'd-card', issueKey: 'PAY-3', grantedByAccountId: OWNER, reason: 'r', createdAt: NOW.toISOString() };
    const r = analyseImpact(decision(), open, [ex], NOW);
    expect(r.affected.map((a) => [a.key, a.waived])).toEqual([['PAY-10', false], ['PAY-3', true]]);
  });
  it('evaluates proposed or superseded decisions as if accepted (preview)', () => {
    expect(analyseImpact(decision({ status: 'proposed' }), open, [], NOW).affected).toHaveLength(2);
  });
  it('does not report status-move rules on standing work', () => {
    const d = decision({ constraints: [{ kind: 'restrict_transition', id: 'c', toStatuses: ['To Do', 'In Progress'] }] });
    expect(analyseImpact(d, open, [], NOW).affected).toHaveLength(0);
  });
});

describe('JQL building', () => {
  it('escapes values and limits to open work in scope', () => {
    expect(jqlString('a "b" \\c')).toBe('"a \\"b\\" \\\\c"');
    expect(scopeToJql({ ...emptyScope(), projectKeys: ['PAY', 'bad key'], labels: ['pci'], components: ['Check "out"'] }))
      .toBe('project in ("PAY") AND statusCategory != Done AND component in ("Check \\"out\\"") AND labels in ("pci") ORDER BY updated DESC');
    expect(scopeToJql(emptyScope())).toBe('statusCategory != Done ORDER BY updated DESC');
  });
});

describe('impact services', () => {
  const search: WorkSearch & { calls: string[] } = {
    calls: [],
    async search(jql) {
      this.calls.push(jql);
      return { items: open, truncated: false };
    },
  };
  const store = new MemoryStore();
  let n = 0;
  const deps = { store, now: () => NOW, newId: () => `id-${++n}` };

  it('analyses a saved decision via its scope', async () => {
    await store.insertDecision(decision());
    const r = await decisionImpact(deps, search, 'd-card');
    expect(r.affected).toHaveLength(2);
    expect(r.jql).toContain('project in ("PAY")');
    await expect(decisionImpact(deps, search, 'nope')).rejects.toThrow(/not found/);
  });
  it('previews a draft without storing it, and validates the draft', async () => {
    const before = (await store.listDecisions()).length;
    const r = await previewImpact(deps, search, { title: 'No PAN logging', statement: 's', ownerAccountId: OWNER, scope: { projectKeys: ['PAY'] }, constraints: [{ kind: 'forbid_terms', terms: ['PAN'] }] });
    expect(r.affected.map((a) => a.key)).toEqual(['PAY-10']);
    expect((await store.listDecisions()).length).toBe(before);
    await expect(previewImpact(deps, search, { title: 'x' })).rejects.toThrow();
  });
});
