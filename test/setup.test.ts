import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('@forge/api', () => ({ default: {}, route: () => '' }));

import { MemoryStore } from '../src/storage/memory';
import type { Deps } from '../src/services/context';
import { getSettings, updateSettings } from '../src/services/settings';
import { seedDemo, demoLoaded, type DemoJira } from '../src/services/demo';
import { runCheck } from '../src/services/checks';
import { chooseIssueType } from '../src/adapters/jira';
import { NOW, OWNER } from './fixtures';

let store: MemoryStore;
let deps: Deps;
let seq = 0;
beforeEach(() => {
  store = new MemoryStore();
  seq = 0;
  deps = { store, now: () => NOW, newId: () => `id-${++seq}` };
});

function fakeJira(): DemoJira & { created: string[] } {
  const created: string[] = [];
  return {
    created,
    async createIssue(input) {
      const key = `${input.projectKey}-${created.length + 1}`;
      created.push(key);
      return key;
    },
  };
}

describe('settings', () => {
  it('Teamwork Graph is off by default and only admins can switch it', async () => {
    expect((await getSettings(deps)).teamworkGraph).toBe(false);
    await expect(updateSettings(deps, { teamworkGraph: true }, false)).rejects.toThrow(/administrators/);
    await expect(updateSettings(deps, { teamworkGraph: 'yes' }, true)).rejects.toThrow(/true or false/);
    expect((await updateSettings(deps, { teamworkGraph: true }, true)).teamworkGraph).toBe(true);
    expect((await updateSettings(deps, { teamworkGraph: false }, true)).teamworkGraph).toBe(false);
  });
});

describe('demo seeding', () => {
  it('creates three accepted demo decisions owned by the seeder and checks three issues', async () => {
    const jira = fakeJira();
    const r = await seedDemo(deps, jira, { projectKey: ' pay ', isAdmin: true }, OWNER);
    expect(r.decisions).toHaveLength(3);
    expect(r.issues.map((i) => i.verdict)).toEqual(['block', 'allow', 'warn']);
    expect(r.issues[0].key).toBe('PAY-1');
    const ds = await store.listDecisions();
    expect(ds.every((d) => d.demo && d.status === 'accepted' && d.ownerAccountId === OWNER)).toBe(true);
    expect(store.receipts).toHaveLength(3);
    expect(store.conflicts.size).toBe(2); // block + warn
    expect(await demoLoaded(deps)).toBe(true);
  });

  it('refuses non-admins, bad keys and a second load', async () => {
    const jira = fakeJira();
    await expect(seedDemo(deps, jira, { projectKey: 'PAY', isAdmin: false }, OWNER)).rejects.toThrow(/administrators/);
    await expect(seedDemo(deps, jira, { projectKey: 'pay-1; drop', isAdmin: true }, OWNER)).rejects.toThrow(/project key/);
    await seedDemo(deps, jira, { projectKey: 'PAY', isAdmin: true }, OWNER);
    await expect(seedDemo(deps, jira, { projectKey: 'PAY', isAdmin: true }, OWNER)).rejects.toThrow(/already loaded/);
    expect(jira.created).toHaveLength(3);
  });

  it('the freeze rule blocks Done on Friday afternoon only', async () => {
    await seedDemo(deps, fakeJira(), { projectKey: 'PAY', isAdmin: true }, OWNER);
    const item = { key: 'PAY-2', projectKey: 'PAY', summary: 'Add Apple Pay', labels: [], components: [], fields: {} };
    const fri = await runCheck(deps, { type: 'transition', actorType: 'human', toStatus: 'Done', item }, { record: false });
    expect(fri.result.verdict).toBe('block');
    const thu = await runCheck({ ...deps, now: () => new Date('2026-12-03T15:00:00Z') }, { type: 'transition', actorType: 'human', toStatus: 'Done', item }, { record: false });
    expect(thu.result.verdict).toBe('allow');
  });
});

describe('runCheck with preloaded decisions', () => {
  it('uses the given decisions and ignores non-accepted ones', async () => {
    const spy = vi.spyOn(store, 'listDecisions');
    await seedDemo(deps, fakeJira(), { projectKey: 'PAY', isAdmin: true }, OWNER);
    const all = await store.listDecisions();
    spy.mockClear();
    const item = { key: 'PAY-9', projectKey: 'PAY', summary: 'store card numbers', labels: [], components: [], fields: {} };
    const r = await runCheck(deps, { type: 'update', actorType: 'human', item }, { record: false, decisions: [...all, { ...all[0], id: 'x', status: 'proposed' }] });
    expect(r.result.verdict).toBe('block');
    expect(r.result.applicableDecisionIds).not.toContain('x');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('chooseIssueType', () => {
  it('prefers Task, then Story, then Bug, never sub-tasks', () => {
    expect(chooseIssueType([{ id: '1', name: 'Sub-task', subtask: true }, { id: '2', name: 'Bug' }, { id: '3', name: 'Story' }])?.id).toBe('3');
    expect(chooseIssueType([{ id: '4', name: 'Epic' }, { id: '5', name: 'Task' }])?.id).toBe('5');
    expect(chooseIssueType([{ id: '6', name: 'Custom' }])?.id).toBe('6');
    expect(chooseIssueType([{ id: '7', name: 'Sub-task', subtask: true }])).toBeUndefined();
  });
});
