import { describe, expect, it, vi } from 'vitest';

vi.mock('@forge/sql', () => ({ sql: {}, migrationRunner: {}, ForgeSQLAPIError: class extends Error {} }));
vi.mock('@forge/api', () => ({ default: {}, route: () => '' }));

import { selfHealing } from '../src/handlers/runtime';
import { normaliseModifiedFields, toWorkItem, requiredFieldIds } from '../src/adapters/jira';
import { adfToText } from '../src/adapters/adf';
import { decision } from './fixtures';

describe('selfHealing store', () => {
  it('runs migrations once on a missing table and retries', async () => {
    let calls = 0;
    const store = { async get() { if (calls++ === 0) throw new Error("Table 'decisions' doesn't exist"); return 'ok'; } };
    const migrate = vi.fn(async () => undefined);
    const s = selfHealing(store, migrate);
    expect(await s.get()).toBe('ok');
    expect(migrate).toHaveBeenCalledTimes(1);
  });
  it('rethrows other errors without migrating', async () => {
    const migrate = vi.fn(async () => undefined);
    const s = selfHealing({ async get() { throw new Error('boom'); } }, migrate);
    await expect(s.get()).rejects.toThrow('boom');
    expect(migrate).not.toHaveBeenCalled();
  });
});

describe('jira adapter mapping', () => {
  it('maps a REST issue to a work item, flattening ADF and applying validator overrides', () => {
    const issue = {
      key: 'PAY-1',
      fields: {
        summary: 'Old summary',
        description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'We will store card data' }] }] },
        labels: ['a'],
        components: [{ name: 'Checkout' }],
        status: { name: 'In Progress' },
        issuetype: { name: 'Story' },
        project: { key: 'PAY' },
        customfield_1: null,
      },
    };
    const w = toWorkItem(issue, normaliseModifiedFields({ labels: null, customfield_1: 'SEC-1' }));
    expect(w.description).toBe('We will store card data');
    expect(w.labels).toEqual([]);
    expect(w.components).toEqual(['Checkout']);
    expect(w.fields.customfield_1).toBe('SEC-1');
    expect(w.projectKey).toBe('PAY');
  });
  it('only requests safe custom field ids', () => {
    const d = decision({ constraints: [
      { kind: 'require_field', id: 'c', field: 'customfield_10042', fieldLabel: 'x', whenEnteringStatuses: ['Done'] },
      { kind: 'require_field', id: 'd', field: 'bad,field&x=1', fieldLabel: 'x', whenEnteringStatuses: ['Done'] },
    ] });
    expect(requiredFieldIds([d])).toEqual(['customfield_10042']);
  });
  it('adfToText handles strings, nesting and limits', () => {
    expect(adfToText('plain')).toBe('plain');
    expect(adfToText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] })).toBe('a\nb');
    expect(adfToText(null)).toBe('');
  });
});
