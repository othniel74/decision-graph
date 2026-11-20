import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/storage/memory';
import type { Deps } from '../src/services/context';
import { createDecision } from '../src/services/decisions';
import { runCheck } from '../src/services/checks';
import { resolveConflict } from '../src/services/reviews';
import { csvCell, evidenceReport } from '../src/services/evidence';
import { action, NOW, OWNER } from './fixtures';

let store: MemoryStore;
let deps: Deps;
let seq = 0;
const draft = {
  title: 'No direct card storage',
  statement: 'We never store card numbers.',
  ownerAccountId: OWNER,
  scope: { projectKeys: ['PAY'] },
  constraints: [{ kind: 'forbid_terms', terms: ['store card'] }],
};
const day = NOW.toISOString().slice(0, 10);

beforeEach(() => {
  store = new MemoryStore();
  seq = 0;
  deps = { store, now: () => NOW, newId: () => `id-${++seq}` };
});

async function conflictBy(accountId: string, key = 'PAY-1') {
  await runCheck(deps, action({ actorAccountId: accountId }, { key, summary: 'store card numbers' }));
  const open = await store.listConflicts({ status: 'open', issueKey: key, limit: 5 });
  return open[0];
}

describe('independent approval', () => {
  it('the owner cannot approve an exception for a conflict they raised; an admin can', async () => {
    await createDecision(deps, draft, OWNER);
    const c = await conflictBy(OWNER);
    const grant = { conflictId: c.id, resolution: 'grant_exception' as const, note: 'Tokenised test data' };
    await expect(resolveConflict(deps, grant, OWNER)).rejects.toThrow(/someone else must approve/);
    await expect(resolveConflict(deps, grant, 'acc-random', { independentApproval: true, actorIsAdmin: false })).rejects.toThrow(/owner/);
    const r = await resolveConflict(deps, grant, 'acc-admin', { independentApproval: true, actorIsAdmin: true });
    expect(r.exception?.grantedByAccountId).toBe('acc-admin');
  });

  it('owner approves conflicts raised by others; switching it off allows self-approval', async () => {
    await createDecision(deps, draft, OWNER);
    const c = await conflictBy('acc-dev');
    expect((await resolveConflict(deps, { conflictId: c.id, resolution: 'grant_exception', note: 'ok' }, OWNER)).conflict.status).toBe('excepted');
    const mine = await conflictBy(OWNER, 'PAY-2');
    const r = await resolveConflict(deps, { conflictId: mine.id, resolution: 'grant_exception', note: 'ok' }, OWNER, { independentApproval: false, actorIsAdmin: false });
    expect(r.conflict.status).toBe('excepted');
  });
});

describe('evidence report', () => {
  it('reports checks, approvals, self-approvals and chain integrity', async () => {
    await createDecision(deps, draft, OWNER);
    await runCheck(deps, action({ actorType: 'rovo_agent', actorName: 'Checkout assistant' }, { key: 'PAY-9', summary: 'tidy docs' }));
    const c = await conflictBy('acc-dev');
    await resolveConflict(deps, { conflictId: c.id, resolution: 'grant_exception', note: 'ok' }, OWNER);
    const mine = await conflictBy(OWNER, 'PAY-2');
    await resolveConflict(deps, { conflictId: mine.id, resolution: 'grant_exception', note: '=HYPERLINK("x")' }, OWNER, { independentApproval: false, actorIsAdmin: false });

    const r = await evidenceReport(deps, { from: day, to: day });
    expect(r.chain.intact).toBe(true);
    expect(r.totals.checks).toBe(3);
    expect(r.totals.blocked).toBe(2);
    expect(r.totals.byAgents).toBe(1);
    expect(r.totals.approvals).toBe(2);
    expect(r.totals.selfApproved).toBe(1);
    expect(r.rows[0].actor).toBe('Checkout assistant');
    expect(r.csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(r.csv.split('\n')[0]).toBe('Checks');

    const other = await evidenceReport(deps, { from: day, to: day, projectKey: 'OPS' });
    expect(other.totals.checks).toBe(0);
  });

  it('rejects bad periods', async () => {
    await expect(evidenceReport(deps, { from: 'yesterday', to: day })).rejects.toThrow(/date/);
    await expect(evidenceReport(deps, { from: '2026-12-01', to: '2026-11-01' })).rejects.toThrow(/on or before/);
    await expect(evidenceReport(deps, { from: '2024-01-01', to: '2026-01-01' })).rejects.toThrow(/year/);
  });

  it('neutralises spreadsheet formulas in CSV cells', () => {
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('plain')).toBe('plain');
  });
});
