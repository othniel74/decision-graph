import { describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({ default: {}, route: () => '' }));

import { check, summarise } from '../src/domain/engine';
import { classifyActor } from '../src/adapters/jira';
import { parseDecisionDraft } from '../src/domain/validate';
import { emptyScope } from '../src/domain/scope';
import { action, decision, NOW, OWNER } from './fixtures';

const strict = (over = {}) => decision({ agentPolicy: 'require_human', enforcement: 'warn', ...over });

describe('agent policy', () => {
  it('blocks agents on a warn decision when people only get a warning', () => {
    const a = (actorType: 'human' | 'rovo_agent' | 'automation' | 'mcp_client') => action({ actorType }, { summary: 'store card numbers' });
    expect(check({ action: a('human'), decisions: [strict()], exceptions: [], now: NOW }).verdict).toBe('warn');
    for (const t of ['rovo_agent', 'automation', 'mcp_client'] as const) {
      const r = check({ action: a(t), decisions: [strict()], exceptions: [], now: NOW });
      expect(r.verdict).toBe('block');
      expect(r.violations[0].agentStrict).toBe(true);
      expect(summarise(r)).toContain('need a person to approve');
    }
  });

  it('agents are not softened by the unconfirmed-link cap', () => {
    const d = decision({ id: 'p', sourcePageId: '1', scope: emptyScope(), agentPolicy: 'require_human' });
    const connections = new Map([['p', { path: ['X-1', 'page "P"'], confirmed: false }]]);
    const human = check({ action: action({}, { key: 'X-1', projectKey: 'X', summary: 'store card' }), decisions: [d], exceptions: [], now: NOW, connections });
    const agent = check({ action: action({ actorType: 'rovo_agent' }, { key: 'X-1', projectKey: 'X', summary: 'store card' }), decisions: [d], exceptions: [], now: NOW, connections });
    expect(human.verdict).toBe('warn');
    expect(agent.verdict).toBe('block');
    expect(agent.violations[0].capped).toBeUndefined();
  });

  it('default policy treats agents like people', () => {
    const r = check({ action: action({ actorType: 'rovo_agent' }, { summary: 'store card' }), decisions: [decision({ enforcement: 'warn' })], exceptions: [], now: NOW });
    expect(r.verdict).toBe('warn');
  });

  it('validates agentPolicy and revisitIf', () => {
    const base = { title: 't', statement: 's', ownerAccountId: OWNER, constraints: [{ kind: 'forbid_labels', labels: ['x'] }] };
    const d = parseDecisionDraft({ ...base, agentPolicy: 'require_human', revisitIf: 'we change provider' }, () => 'c');
    expect(d.agentPolicy).toBe('require_human');
    expect(d.revisitIf).toBe('we change provider');
    expect(() => parseDecisionDraft({ ...base, agentPolicy: 'yolo' }, () => 'c')).toThrow(/agentPolicy/);
  });
});

describe('classifyActor', () => {
  it('maps app accounts to agents or automation, everyone else to people', () => {
    expect(classifyActor(null)).toEqual({ actorType: 'human' });
    expect(classifyActor({ accountId: 'a', accountType: 'atlassian', displayName: 'Sam', active: true })).toEqual({ actorType: 'human' });
    expect(classifyActor({ accountId: 'b', accountType: 'app', displayName: 'Automation for Jira', active: true })).toEqual({ actorType: 'automation', actorName: 'Automation for Jira' });
    expect(classifyActor({ accountId: 'c', accountType: 'app', displayName: 'Checkout assistant', active: true })).toEqual({ actorType: 'rovo_agent', actorName: 'Checkout assistant' });
  });
});
