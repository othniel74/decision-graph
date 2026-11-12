import { dueForReview } from '../domain/lifecycle';
import { verifyChain, type Receipt } from '../domain/receipt';
import type { Deps } from './context';

export interface HealthSummary {
  accepted: number;
  proposed: number;
  superseded: number;
  dueForReview: number;
  openConflicts: number;
  recentChecks: number;
  recentBlocked: number;
  recentWarned: number;
  recentWaived: number;
  byActor: Record<string, number>;
}

const PAGE = 500;

/** Verify the full receipt chain page by page. Returns the first broken sequence, or null. */
export async function verifyAuditTrail(deps: Deps): Promise<{ checked: number; brokenAt: number | null }> {
  let from = 1;
  let checked = 0;
  let prev: Receipt | null = null;
  for (;;) {
    const page = await deps.store.listReceipts({ fromSequence: from, limit: PAGE });
    if (page.length === 0) return { checked, brokenAt: null };
    const run = prev ? [prev, ...page] : page;
    const broken = verifyChain(run);
    if (broken !== null) return { checked: checked + page.length, brokenAt: broken };
    checked += page.length;
    prev = page[page.length - 1];
    if (page.length < PAGE) return { checked, brokenAt: null };
    from = prev.sequence + 1;
  }
}

export async function health(deps: Deps): Promise<HealthSummary> {
  const [decisions, open, latest] = await Promise.all([
    deps.store.listDecisions(),
    deps.store.listConflicts({ status: 'open', limit: 500 }),
    deps.store.latestReceipt(),
  ]);
  const from = latest ? Math.max(1, latest.sequence - 499) : 1;
  const recent = latest ? await deps.store.listReceipts({ fromSequence: from, limit: 500 }) : [];
  const byActor: Record<string, number> = {};
  for (const r of recent) byActor[r.actorType] = (byActor[r.actorType] ?? 0) + 1;
  const count = (s: string) => decisions.filter((d) => d.status === s).length;
  return {
    accepted: count('accepted'),
    proposed: count('proposed'),
    superseded: count('superseded'),
    dueForReview: dueForReview(decisions, deps.now()).length,
    openConflicts: open.length,
    recentChecks: recent.length,
    recentBlocked: recent.filter((r) => r.verdict === 'block').length,
    recentWarned: recent.filter((r) => r.verdict === 'warn').length,
    recentWaived: recent.filter((r) => r.waivedCount > 0).length,
    byActor,
  };
}
