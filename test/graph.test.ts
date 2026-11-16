import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('@forge/api', () => ({ default: {}, route: () => '' }));

import { pagesReachable, issuesReaching, connectionsFor, confluencePageId, graphIsFresh, type Edge } from '../src/domain/graph';
import { MemoryStore } from '../src/storage/memory';
import type { Deps } from '../src/services/context';
import { connectionsForItem, setPathOverride, reportsForOwner, sweep, refreshNeighbourhood, GRAPH_REFRESHED_KEY, STRONG_LINKS_KEY, type GraphSource } from '../src/services/graph';
import { runCheck } from '../src/services/checks';
import { decisionImpact } from '../src/services/impact';
import { verifyChain } from '../src/domain/receipt';
import { emptyScope } from '../src/domain/scope';
import { decision, item, NOW, OWNER } from './fixtures';

const E = {
  parent: (from: string, to: string): Edge => ({ from: `issue:${from}`, to: `issue:${to}`, type: 'parent' }),
  page: (from: string, id: string, title: string): Edge => ({ from: `issue:${from}`, to: `page:${id}`, type: 'page_link', toLabel: title }),
  link: (from: string, to: string, name: string, phrase: string): Edge => ({ from: `issue:${from}`, to: `issue:${to}`, type: 'issue_link', linkType: name, toLabel: phrase }),
};

const edges: Edge[] = [
  E.parent('PAY-7', 'PAY-12'),
  E.page('PAY-12', '123', 'Payments Architecture'),
  E.link('PAY-7', 'PAY-9', 'Blocks', 'is blocked by'),
  E.page('PAY-9', '456', 'Release Rules'),
  E.parent('PAY-12', 'PAY-1'),
  E.page('PAY-1', '789', 'Three hops away'),
];

describe('pagesReachable', () => {
  it('follows parent and page links within two hops, with readable paths', () => {
    const r = pagesReachable('PAY-7', edges);
    expect(r.get('123')).toEqual(['PAY-7', 'parent PAY-12', 'page "Payments Architecture"']);
    expect(r.has('789')).toBe(false); // 3 hops
  });
  it('ignores issue links unless named strong', () => {
    expect(pagesReachable('PAY-7', edges).has('456')).toBe(false);
    expect(pagesReachable('PAY-7', edges, { maxHops: 2, strongIssueLinks: ['blocks'] }).get('456')).toEqual(['PAY-7', 'is blocked by PAY-9', 'page "Release Rules"']);
  });
  it('is deterministic regardless of edge order and handles cycles', () => {
    const cyc = [...edges, E.parent('PAY-12', 'PAY-7')];
    expect(pagesReachable('PAY-7', [...cyc].reverse())).toEqual(pagesReachable('PAY-7', cyc));
  });
});

describe('issuesReaching', () => {
  it('finds work that reaches a page, with the same path as the forward search', async () => {
    const to = async (nodes: string[]) => edges.filter((e) => nodes.includes(e.to));
    const r = await issuesReaching('123', to);
    expect(r.get('PAY-12')).toEqual(['PAY-12', 'page "Payments Architecture"']);
    expect(r.get('PAY-7')).toEqual(pagesReachable('PAY-7', edges).get('123'));
  });
});

describe('connectionsFor and helpers', () => {
  const d = decision({ id: 'd1', sourcePageId: '123', scope: emptyScope() });
  const pages = pagesReachable('PAY-7', edges);
  const o = (state: 'confirmed' | 'excluded' | 'reported') => [{ decisionId: 'd1', issueKey: 'PAY-7', state, byAccountId: OWNER, at: NOW.toISOString() }];
  it('honours owner overrides; reports change nothing', () => {
    expect(connectionsFor([d], pages, 'PAY-7', []).get('d1')?.confirmed).toBe(false);
    expect(connectionsFor([d], pages, 'PAY-7', o('confirmed')).get('d1')?.confirmed).toBe(true);
    expect(connectionsFor([d], pages, 'PAY-7', o('excluded')).has('d1')).toBe(false);
    expect(connectionsFor([d], pages, 'PAY-7', o('reported')).get('d1')?.confirmed).toBe(false);
    expect(connectionsFor([decision({ id: 'd2', sourcePageId: '123', reach: 'scope' })], pages, 'PAY-7', []).size).toBe(0);
  });
  it('parses Confluence page ids from remote links', () => {
    expect(confluencePageId('appId=abc&pageId=98765', undefined)).toBe('98765');
    expect(confluencePageId(undefined, 'https://x.atlassian.net/wiki/spaces/ARCH/pages/12345/Payments')).toBe('12345');
    expect(confluencePageId(undefined, 'https://x.atlassian.net/wiki/pages/viewpage.action?pageId=555')).toBe('555');
    expect(confluencePageId(undefined, 'https://github.com/x')).toBeNull();
  });
  it('treats an old or missing refresh as stale', () => {
    expect(graphIsFresh(null, NOW)).toBe(false);
    expect(graphIsFresh('2026-12-03T16:00:00Z', NOW)).toBe(true);
    expect(graphIsFresh('2026-12-01T00:00:00Z', NOW)).toBe(false);
  });
});

describe('graph services', () => {
  let store: MemoryStore;
  let deps: Deps;
  let n = 0;
  const pageDecision = decision({ id: 'd1', title: 'No card storage', sourcePageId: '123', scope: emptyScope() });
  const src: GraphSource = {
    async issueEdges(k) {
      const key = k;
      return { key, edges: edges.filter((e) => e.from === `issue:${key}`) };
    },
    async recentlyUpdated() {
      return ['PAY-7', 'PAY-12', 'PAY-9'];
    },
  };

  beforeEach(async () => {
    store = new MemoryStore();
    deps = { store, now: () => NOW, newId: () => `id-${++n}` };
    await store.insertDecision(pageDecision);
  });

  it('sweep fills the graph and marks it fresh; a failure leaves it stale', async () => {
    expect((await connectionsForItem(deps, 'PAY-7', [pageDecision])).stale).toBe(true);
    expect(await sweep(deps, src, { days: 1, cap: 100 })).toEqual({ refreshed: 3, failed: 0 });
    const c = await connectionsForItem(deps, 'PAY-7', [pageDecision]);
    expect(c.stale).toBe(false);
    expect(c.connections.get('d1')?.path).toEqual(['PAY-7', 'parent PAY-12', 'page "Payments Architecture"']);

    const fresh = new MemoryStore();
    const failing: GraphSource = { ...src, async issueEdges(k) { if (k === 'PAY-9') throw new Error('boom'); return src.issueEdges(k); } };
    expect((await sweep({ ...deps, store: fresh }, failing, { days: 1, cap: 100 })).failed).toBe(1);
    expect(await fresh.getSetting(GRAPH_REFRESHED_KEY)).toBeNull();
  });

  it('end to end: a connected decision warns, owner confirms, then it blocks; receipts record the path', async () => {
    await sweep(deps, src, { days: 1, cap: 100 });
    const a = { type: 'update' as const, actorType: 'human' as const, actorAccountId: 'dev', item: item({ key: 'PAY-7', projectKey: 'PAY', summary: 'Store card numbers' }) };
    const first = await runCheck(deps, a);
    expect(first.result.verdict).toBe('warn');
    expect(first.receipt?.paths?.[0]).toContain('d1: PAY-7 → parent PAY-12');
    expect(first.receipt?.graphAt).toBeDefined();
    await expect(setPathOverride(deps, { decisionId: 'd1', issueKey: 'PAY-7', state: 'confirmed' }, 'dev')).rejects.toThrow(/owner/);
    await setPathOverride(deps, { decisionId: 'd1', issueKey: 'pay-7', state: 'confirmed' }, OWNER);
    expect((await runCheck(deps, a)).result.verdict).toBe('block');
    await setPathOverride(deps, { decisionId: 'd1', issueKey: 'PAY-7', state: 'excluded' }, OWNER);
    expect((await runCheck(deps, a)).result.verdict).toBe('allow');
    expect(verifyChain(store.receipts)).toBeNull();
  });

  it('anyone may report a path; a report never overrides the owner', async () => {
    await expect(setPathOverride(deps, { decisionId: 'd1', issueKey: 'PAY-7', state: 'reported' }, 'dev')).rejects.toThrow(/note/);
    await setPathOverride(deps, { decisionId: 'd1', issueKey: 'PAY-7', state: 'reported', note: 'Only touches receipts UI' }, 'dev');
    expect(await reportsForOwner(deps, OWNER)).toHaveLength(1);
    await setPathOverride(deps, { decisionId: 'd1', issueKey: 'PAY-7', state: 'confirmed' }, OWNER);
    const kept = await setPathOverride(deps, { decisionId: 'd1', issueKey: 'PAY-7', state: 'reported', note: 'again' }, 'dev');
    expect(kept.state).toBe('confirmed');
  });

  it('strong issue links are a site setting', async () => {
    await sweep(deps, src, { days: 1, cap: 100 });
    const release = decision({ id: 'd2', title: 'Release rules', sourcePageId: '456', scope: emptyScope() });
    expect((await connectionsForItem(deps, 'PAY-7', [release])).connections.size).toBe(0);
    await store.setSetting(STRONG_LINKS_KEY, JSON.stringify(['Blocks']));
    expect((await connectionsForItem(deps, 'PAY-7', [release])).connections.get('d2')?.path[1]).toBe('is blocked by PAY-9');
  });

  it('refreshNeighbourhood refreshes the issue and its linked issues', async () => {
    const spy = vi.spyOn(src, 'issueEdges');
    await refreshNeighbourhood(deps, src, 'PAY-7');
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(['PAY-12', 'PAY-7']);
  });

  it('trial-run conflicts are recorded as shadow, never open', async () => {
    const trial = decision({ id: 'd3', trialUntil: '2026-12-31T00:00:00Z' });
    await store.insertDecision(trial);
    const r = await runCheck(deps, { type: 'update', actorType: 'human', item: item({ summary: 'store card' }) });
    expect(r.result.verdict).toBe('allow');
    expect(r.conflicts).toHaveLength(0);
    expect([...store.conflicts.values()].map((c) => c.status)).toEqual(['shadow']);
    expect(r.receipt?.shadowCount).toBe(1);
  });

  it('impact analysis includes connected work with its path', async () => {
    await sweep(deps, src, { days: 1, cap: 100 });
    const items = [item({ key: 'PAY-7', summary: 'Store card numbers' }), item({ key: 'PAY-12', summary: 'Payments epic' })];
    const search = { async search(jql: string) { return { items: items.filter((i) => jql.includes(i.key!)), truncated: false }; } };
    const r = await decisionImpact(deps, search, 'd1');
    expect(r.connectedCount).toBe(2);
    expect(r.affected.map((a) => a.key)).toEqual(['PAY-7']);
    expect(r.affected[0].violations[0].path?.[1]).toBe('parent PAY-12');
  });
});

import { edgesFromJira } from '../src/adapters/jira';
import { updateSettings, getSettings } from '../src/services/settings';

describe('edgesFromJira', () => {
  it('maps parent, issue links and Confluence remote links; ignores other remote links', () => {
    const edges = edgesFromJira(
      {
        key: 'PAY-7',
        fields: {
          parent: { key: 'PAY-12' },
          issuelinks: [
            { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'PAY-9' } },
            { type: { name: 'Relates', inward: 'relates to', outward: 'relates to' }, outwardIssue: { key: 'WEB-3' } },
          ],
        },
      },
      [
        { globalId: 'appId=abc&pageId=123', application: { type: 'com.atlassian.confluence' }, object: { url: 'https://x/wiki/pages/viewpage.action?pageId=123', title: 'Payments Architecture' } },
        { application: { type: 'com.github' }, object: { url: 'https://github.com/x/pull/1', title: 'PR' } },
        { globalId: 'appId=abc&pageId=123', application: { type: 'com.atlassian.confluence' }, object: { title: 'Duplicate' } },
      ],
    );
    expect(edges).toEqual([
      { from: 'issue:PAY-7', to: 'issue:PAY-12', type: 'parent' },
      { from: 'issue:PAY-7', to: 'issue:PAY-9', type: 'issue_link', linkType: 'Blocks', toLabel: 'is blocked by' },
      { from: 'issue:PAY-7', to: 'issue:WEB-3', type: 'issue_link', linkType: 'Relates', toLabel: 'relates to' },
      { from: 'issue:PAY-7', to: 'page:123', type: 'page_link', toLabel: 'Payments Architecture' },
    ]);
  });
});

describe('link settings', () => {
  it('admins set strong link types; graph refresh time is reported', async () => {
    const store = new MemoryStore();
    const deps = { store, now: () => NOW, newId: () => 'x' };
    await expect(updateSettings(deps, { strongIssueLinks: ['Blocks'] }, false)).rejects.toThrow(/administrators/);
    expect((await updateSettings(deps, { strongIssueLinks: ['Blocks', 'Blocks', 'Cloners'] }, true)).strongIssueLinks).toEqual(['Blocks', 'Cloners']);
    await store.setSetting(GRAPH_REFRESHED_KEY, NOW.toISOString());
    expect((await getSettings(deps)).graphRefreshedAt).toBe(NOW.toISOString());
  });
});
