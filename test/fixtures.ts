import type { Decision, ProposedAction, WorkItem } from '../src/domain/types';
import { emptyScope } from '../src/domain/scope';

export const OWNER = 'acc-owner';
export const NOW = new Date('2026-12-04T15:00:00Z'); // Friday 15:00 London

export function decision(over: Partial<Decision> = {}): Decision {
  return {
    id: 'd-card',
    title: 'No direct card storage in payments',
    statement: 'Card numbers are never stored by our services; we use the PSP vault.',
    rationale: 'PCI DSS scope reduction.',
    ownerAccountId: OWNER,
    status: 'accepted',
    enforcement: 'block',
    scope: { ...emptyScope(), projectKeys: ['PAY'] },
    constraints: [
      { kind: 'forbid_terms', id: 'c1', terms: ['store card', 'card number', 'PAN'], fields: ['summary', 'description', 'proposal'] },
    ],
    sourceUrl: 'https://example.atlassian.net/wiki/spaces/ARCH/pages/1',
    createdAt: '2026-01-10T10:00:00Z',
    updatedAt: '2026-01-10T10:00:00Z',
    version: 1,
    ...over,
  };
}

export function item(over: Partial<WorkItem> = {}): WorkItem {
  return { key: 'PAY-42', projectKey: 'PAY', issueType: 'Story', summary: 'Speed up checkout', labels: [], components: [], fields: {}, ...over };
}

export function action(over: Partial<ProposedAction> = {}, itemOver: Partial<WorkItem> = {}): ProposedAction {
  return { type: 'update', actorType: 'human', actorAccountId: 'acc-dev', item: item(itemOver), ...over };
}
