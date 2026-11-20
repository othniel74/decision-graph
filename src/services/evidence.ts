import { DomainError } from '../domain/lifecycle';
import type { Receipt } from '../domain/receipt';
import type { Conflict } from '../storage/store';
import { verifyAuditTrail } from './audit';
import type { Deps } from './context';

/**
 * Change-control evidence for auditors (SOC 2 CC8.1, ISO 27001 A.8.32, DORA change management):
 * every check in a period, who acted (person, agent or automation), the verdict, which decisions
 * applied, every approval with requester and approver, and whether the receipt chain is intact.
 */
export interface EvidenceRow {
  sequence: number;
  at: string;
  issueKey: string;
  projectKey: string;
  actorType: string;
  actor: string;
  action: string;
  verdict: string;
  decisions: string;
  waived: number;
  hash: string;
}

export interface ApprovalRow {
  conflictId: string;
  issueKey: string;
  decision: string;
  outcome: string;
  raisedBy: string;
  raisedByType: string;
  resolvedBy: string;
  raisedAt: string;
  resolvedAt: string;
  note: string;
  /** The person who raised the conflict also resolved it. */
  selfApproved: boolean;
}

export interface EvidenceReport {
  from: string;
  to: string;
  projectKey?: string;
  generatedAt: string;
  chain: { checked: number; intact: boolean; brokenAt: number | null };
  totals: { checks: number; blocked: number; warned: number; byAgents: number; approvals: number; selfApproved: number };
  rows: EvidenceRow[];
  approvals: ApprovalRow[];
  truncated: boolean;
  csv: string;
}

const PAGE = 500;
const MAX_ROWS = 5000;
const MAX_DAYS = 366;

function day(v: unknown, name: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw new DomainError(`${name} must be a date like 2026-11-01.`, 'INVALID');
  }
  return v;
}

export async function evidenceReport(deps: Deps, input: { from?: unknown; to?: unknown; projectKey?: unknown }): Promise<EvidenceReport> {
  const from = day(input.from, 'from');
  const to = day(input.to, 'to');
  const projectKey = typeof input.projectKey === 'string' && input.projectKey.trim() ? input.projectKey.trim().toUpperCase() : undefined;
  const start = `${from}T00:00:00.000Z`;
  const end = `${to}T23:59:59.999Z`;
  if (start > end) throw new DomainError('The start date must be on or before the end date.', 'INVALID');
  if ((Date.parse(end) - Date.parse(start)) / 86_400_000 > MAX_DAYS) throw new DomainError('Choose a period of a year or less.', 'INVALID');

  const decisions = new Map((await deps.store.listDecisions()).map((d) => [d.id, d.title]));
  const inScope = (r: { createdAt: string; projectKey: string }) => r.createdAt >= start && r.createdAt <= end && (!projectKey || r.projectKey === projectKey);

  const receipts: Receipt[] = [];
  let truncated = false;
  for (let seq = 1; ; ) {
    const page = await deps.store.listReceipts({ fromSequence: seq, limit: PAGE });
    for (const r of page) {
      if (!inScope(r)) continue;
      if (receipts.length >= MAX_ROWS) { truncated = true; break; }
      receipts.push(r);
    }
    if (truncated || page.length < PAGE) break;
    seq = page[page.length - 1].sequence + 1;
  }

  const resolved = (await deps.store.listConflicts({ limit: MAX_ROWS })).filter(
    (c) => ['excepted', 'upheld', 'withdrawn'].includes(c.status) && c.resolvedAt && c.resolvedAt >= start && c.resolvedAt <= end && (!projectKey || c.projectKey === projectKey),
  );

  const chain = await verifyAuditTrail(deps);
  const rows = receipts.map((r) => toRow(r, decisions));
  const approvals = resolved.map((c) => toApproval(c, decisions)).sort((a, b) => a.resolvedAt.localeCompare(b.resolvedAt));
  return {
    from,
    to,
    projectKey,
    generatedAt: deps.now().toISOString(),
    chain: { checked: chain.checked, intact: chain.brokenAt === null, brokenAt: chain.brokenAt },
    totals: {
      checks: rows.length,
      blocked: rows.filter((r) => r.verdict === 'block').length,
      warned: rows.filter((r) => r.verdict === 'warn').length,
      byAgents: rows.filter((r) => r.actorType !== 'human').length,
      approvals: approvals.filter((a) => a.outcome === 'exception granted').length,
      selfApproved: approvals.filter((a) => a.selfApproved && a.outcome === 'exception granted').length,
    },
    rows,
    approvals,
    truncated,
    csv: toCsv(rows, approvals),
  };
}

function toRow(r: Receipt, titles: Map<string, string>): EvidenceRow {
  return {
    sequence: r.sequence,
    at: r.createdAt,
    issueKey: r.issueKey ?? '',
    projectKey: r.projectKey,
    actorType: r.actorType,
    actor: r.actorName ?? r.actorAccountId ?? '',
    action: r.toStatus ? `${r.actionType} → ${r.toStatus}` : r.actionType,
    verdict: r.verdict,
    decisions: r.decisionIds.map((id) => titles.get(id) ?? id).join('; '),
    waived: r.waivedCount,
    hash: r.hash,
  };
}

const OUTCOME: Record<string, string> = { excepted: 'exception granted', upheld: 'upheld', withdrawn: 'withdrawn' };

function toApproval(c: Conflict, titles: Map<string, string>): ApprovalRow {
  return {
    conflictId: c.id,
    issueKey: c.issueKey ?? '',
    decision: titles.get(c.decisionId) ?? c.decisionId,
    outcome: OUTCOME[c.status] ?? c.status,
    raisedBy: c.actorName ?? c.actorAccountId ?? '',
    raisedByType: c.actorType,
    resolvedBy: c.resolvedByAccountId ?? '',
    raisedAt: c.createdAt,
    resolvedAt: c.resolvedAt ?? '',
    note: c.resolutionNote ?? '',
    selfApproved: !!c.actorAccountId && c.actorAccountId === c.resolvedByAccountId,
  };
}

/** CSV with formula-injection protection: cells starting with = + - @ are prefixed with '. */
export function csvCell(v: unknown): string {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: EvidenceRow[], approvals: ApprovalRow[]): string {
  const line = (cells: unknown[]) => cells.map(csvCell).join(',');
  const out = [
    'Checks',
    line(['sequence', 'time', 'issue', 'project', 'actor type', 'actor', 'action', 'verdict', 'decisions', 'waived', 'receipt hash']),
    ...rows.map((r) => line([r.sequence, r.at, r.issueKey, r.projectKey, r.actorType, r.actor, r.action, r.verdict, r.decisions, r.waived, r.hash])),
    '',
    'Approvals',
    line(['issue', 'decision', 'outcome', 'raised by', 'raised by type', 'resolved by', 'raised at', 'resolved at', 'self-approved', 'note']),
    ...approvals.map((a) => line([a.issueKey, a.decision, a.outcome, a.raisedBy, a.raisedByType, a.resolvedBy, a.raisedAt, a.resolvedAt, a.selfApproved ? 'yes' : 'no', a.note])),
  ];
  return out.join('\n');
}
