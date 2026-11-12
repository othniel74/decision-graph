import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryStore } from '../src/storage/memory';
import type { Deps } from '../src/services/context';
import { createDecision, changeStatus, supersedeDecision, getDecisionWithHistory } from '../src/services/decisions';
import { runCheck } from '../src/services/checks';
import { resolveConflict, requestException, myReviewQueue } from '../src/services/reviews';
import { verifyAuditTrail, health } from '../src/services/audit';
import { action, NOW, OWNER } from './fixtures';

let store: MemoryStore;
let deps: Deps;
let seq = 0;

const draft = {
  title: 'No direct card storage',
  statement: 'We never store card numbers.',
  ownerAccountId: OWNER,
  scope: { projectKeys: ['PAY'] },
  constraints: [{ kind: 'forbid_terms', terms: ['store card', 'card number'] }],
};

beforeEach(() => {
  store = new MemoryStore();
  seq = 0;
  deps = { store, now: () => NOW, newId: () => `id-${++seq}` };
});

describe('decisions service', () => {
  it('auto-accepts when the proposer is the owner, otherwise proposes', async () => {
    expect((await createDecision(deps, draft, OWNER)).status).toBe('accepted');
    const p = await createDecision(deps, draft, 'acc-pm');
    expect(p.status).toBe('proposed');
    await expect(changeStatus(deps, p.id, 'accepted', 'acc-pm')).rejects.toThrow(/owner/);
    expect((await changeStatus(deps, p.id, 'accepted', OWNER)).status).toBe('accepted');
  });

  it('supersedes with linked history and enforces only the replacement', async () => {
    const old = await createDecision(deps, draft, OWNER);
    const { replacement } = await supersedeDecision(deps, old.id, { ...draft, title: 'Vault tokens only', constraints: [{ kind: 'forbid_terms', terms: ['raw PAN'] }] }, OWNER);
    const h = await getDecisionWithHistory(deps, replacement.id);
    expect(h.history.map((d) => d.id)).toEqual([old.id]);
    const r = await runCheck(deps, action({}, { summary: 'store card numbers' }));
    expect(r.result.verdict).toBe('allow');
    const r2 = await runCheck(deps, action({}, { summary: 'log the raw PAN' }));
    expect(r2.result.verdict).toBe('block');
  });

  it('rolls back the replacement if the old decision changed concurrently', async () => {
    const old = await createDecision(deps, draft, OWNER);
    const orig = store.updateDecision.bind(store);
    let first = true;
    store.updateDecision = async (d, v) => {
      if (first && d.id === old.id) {
        first = false;
        throw Object.assign(new Error('changed'), {});
      }
      return orig(d, v);
    };
    await expect(supersedeDecision(deps, old.id, draft, OWNER)).rejects.toThrow('changed');
    const all = await store.listDecisions();
    expect(all.filter((d) => d.status === 'accepted').map((d) => d.id)).toEqual([old.id]);
  });
});

describe('check and review flow', () => {
  it('blocked action records a receipt and opens one conflict, deduplicated on retry', async () => {
    await createDecision(deps, draft, OWNER);
    const a = action({ actorType: 'rovo_agent', actorName: 'Checkout agent' }, { summary: 'Store card numbers' });
    const first = await runCheck(deps, a);
    expect(first.result.verdict).toBe('block');
    expect(first.receipt?.sequence).toBe(1);
    expect(first.conflicts).toHaveLength(1);
    const second = await runCheck(deps, a);
    expect(second.receipt?.sequence).toBe(2);
    expect(second.conflicts[0].id).toBe(first.conflicts[0].id);
    expect(store.conflicts.size).toBe(1);
    expect((await myReviewQueue(deps, OWNER)).length).toBe(1);
  });

  it('preview checks record nothing', async () => {
    await createDecision(deps, draft, OWNER);
    const r = await runCheck(deps, action({}, { summary: 'store card' }), { record: false });
    expect(r.result.verdict).toBe('block');
    expect(store.receipts).toHaveLength(0);
    expect(store.conflicts.size).toBe(0);
  });

  it('owner grants an exception, which then allows the action and is audited', async () => {
    await createDecision(deps, draft, OWNER);
    const a = action({}, { summary: 'store card' });
    const { conflicts } = await runCheck(deps, a);
    await requestException(deps, conflicts[0].id, 'Test fixtures only, tokenised', 'acc-dev');
    await expect(resolveConflict(deps, { conflictId: conflicts[0].id, resolution: 'grant_exception', note: 'ok' }, 'acc-dev')).rejects.toThrow(/owner/);
    await expect(resolveConflict(deps, { conflictId: conflicts[0].id, resolution: 'grant_exception' }, OWNER)).rejects.toThrow(/note is required/);
    const res = await resolveConflict(deps, { conflictId: conflicts[0].id, resolution: 'grant_exception', note: 'Tokenised fixtures', expiresAt: '2027-01-01' }, OWNER);
    expect(res.conflict.status).toBe('excepted');
    const after = await runCheck(deps, a);
    expect(after.result.verdict).toBe('allow');
    expect(after.result.waived).toHaveLength(1);
    expect(after.conflicts).toHaveLength(0);
  });

  it('upheld conflicts stay blocked; the requester may withdraw', async () => {
    await createDecision(deps, draft, OWNER);
    const a = action({ actorAccountId: 'acc-dev' }, { summary: 'store card' });
    const c1 = (await runCheck(deps, a)).conflicts[0];
    await resolveConflict(deps, { conflictId: c1.id, resolution: 'uphold', note: 'Use the vault' }, OWNER);
    await expect(resolveConflict(deps, { conflictId: c1.id, resolution: 'uphold' }, OWNER)).rejects.toThrow(/already resolved/);
    const again = await runCheck(deps, a);
    expect(again.result.verdict).toBe('block');
    const c2 = again.conflicts[0];
    expect(c2.id).not.toBe(c1.id);
    expect((await resolveConflict(deps, { conflictId: c2.id, resolution: 'withdraw' }, 'acc-dev')).conflict.status).toBe('withdrawn');
  });

  it('retries receipt append on a sequence collision', async () => {
    await createDecision(deps, draft, OWNER);
    const orig = store.insertReceipt.bind(store);
    let collide = true;
    store.insertReceipt = async (r) => {
      if (collide) {
        collide = false;
        await orig({ ...r, id: 'other-writer' });
      }
      return orig(r);
    };
    const r = await runCheck(deps, action());
    expect(r.receipt?.sequence).toBe(2);
  });

  it('audit trail verifies and health summarises', async () => {
    await createDecision(deps, draft, OWNER);
    for (let i = 0; i < 4; i++) await runCheck(deps, action({}, { summary: i % 2 ? 'store card' : 'ok' }));
    expect(await verifyAuditTrail(deps)).toEqual({ checked: 4, brokenAt: null });
    expect(store.receipts[2].verdict).toBe('allow');
    store.receipts[2] = { ...store.receipts[2], verdict: 'block' as const };
    expect((await verifyAuditTrail(deps)).brokenAt).toBe(3);
    const h = await health(deps);
    expect(h.accepted).toBe(1);
    expect(h.openConflicts).toBe(1);
    expect(h.recentChecks).toBe(4);
  });
});
