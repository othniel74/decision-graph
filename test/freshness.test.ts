import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/storage/memory';
import type { Deps } from '../src/services/context';
import { confirmStillValid, createDecision, decisionsDueForReview, reassignOwner } from '../src/services/decisions';
import { NOW, OWNER } from './fixtures';

let deps: Deps;
let seq = 0;
const draft = {
  title: 'Postgres only',
  statement: 'We use Postgres.',
  ownerAccountId: OWNER,
  scope: { projectKeys: ['PAY'] },
  constraints: [{ kind: 'forbid_terms', terms: ['mongodb'] }],
  reviewBy: '2026-01-01',
  revisitIf: 'we exceed one billion rows',
};

beforeEach(() => {
  seq = 0;
  deps = { store: new MemoryStore(), now: () => NOW, newId: () => `id-${++seq}` };
});

describe('decision freshness', () => {
  it('keeps revisit-if, flags due decisions, and the owner can confirm them', async () => {
    const d = await createDecision(deps, draft, OWNER);
    expect(d.revisitIf).toBe('we exceed one billion rows');
    expect((await decisionsDueForReview(deps)).map((x) => x.id)).toEqual([d.id]);
    await expect(confirmStillValid(deps, d.id, 'acc-dev')).rejects.toThrow(/owner/);
    await expect(confirmStillValid(deps, d.id, OWNER, '2020-01-01')).rejects.toThrow(/future/);
    const ok = await confirmStillValid(deps, d.id, OWNER);
    expect(Date.parse(ok.reviewBy!)).toBeGreaterThan(NOW.getTime());
    expect(ok.lastReviewedAt).toBe(NOW.toISOString());
    expect(await decisionsDueForReview(deps)).toEqual([]);
  });

  it('owner or an admin can reassign; others cannot', async () => {
    const d = await createDecision(deps, draft, OWNER);
    await expect(reassignOwner(deps, d.id, 'acc-new', 'acc-dev', false)).rejects.toThrow(/administrator/);
    await expect(reassignOwner(deps, d.id, '', 'acc-admin', true)).rejects.toThrow(/new owner/);
    expect((await reassignOwner(deps, d.id, 'acc-new', 'acc-admin', true)).ownerAccountId).toBe('acc-new');
    expect((await reassignOwner(deps, d.id, 'acc-third', 'acc-new', false)).ownerAccountId).toBe('acc-third');
  });
});
