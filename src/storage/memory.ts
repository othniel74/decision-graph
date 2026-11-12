import { DomainError } from '../domain/lifecycle';
import type { Decision, DecisionException } from '../domain/types';
import type { Receipt } from '../domain/receipt';
import type { Conflict, DecisionFilter, Store } from './store';

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  decisions = new Map<string, Decision>();
  exceptions: DecisionException[] = [];
  receipts: Receipt[] = [];
  conflicts = new Map<string, Conflict>();
  settings = new Map<string, string>();

  async getSetting(key: string) {
    return this.settings.get(key) ?? null;
  }
  async setSetting(key: string, value: string) {
    this.settings.set(key, value);
  }

  async listDecisions(f: DecisionFilter = {}): Promise<Decision[]> {
    return [...this.decisions.values()]
      .filter((d) => !f.statuses || f.statuses.includes(d.status))
      .filter((d) => !f.ownerAccountId || d.ownerAccountId === f.ownerAccountId)
      .filter((d) => !f.sourcePageId || d.sourcePageId === f.sourcePageId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(clone);
  }
  async getDecision(id: string) {
    const d = this.decisions.get(id);
    return d ? clone(d) : null;
  }
  async insertDecision(d: Decision) {
    if (this.decisions.has(d.id)) throw new DomainError('Decision already exists.', 'CONFLICT');
    this.decisions.set(d.id, clone(d));
  }
  async updateDecision(d: Decision, expectedVersion: number) {
    const cur = this.decisions.get(d.id);
    if (!cur) throw new DomainError('Decision not found.', 'NOT_FOUND');
    if (cur.version !== expectedVersion) throw new DomainError('Decision was changed by someone else. Reload and try again.', 'CONFLICT');
    this.decisions.set(d.id, clone(d));
  }

  async listExceptions(f: { issueKey?: string; decisionId?: string }) {
    return this.exceptions
      .filter((e) => (!f.issueKey || e.issueKey === f.issueKey) && (!f.decisionId || e.decisionId === f.decisionId))
      .map(clone);
  }
  async insertException(e: DecisionException) {
    this.exceptions.push(clone(e));
  }

  async latestReceipt() {
    const r = this.receipts.at(-1);
    return r ? clone(r) : null;
  }
  async insertReceipt(r: Receipt) {
    if (this.receipts.some((x) => x.sequence === r.sequence)) throw new DomainError('Receipt sequence taken.', 'CONFLICT');
    this.receipts.push(clone(r));
    this.receipts.sort((a, b) => a.sequence - b.sequence);
  }
  async listReceipts(o: { fromSequence?: number; limit: number; issueKey?: string }) {
    return this.receipts
      .filter((r) => (o.fromSequence === undefined || r.sequence >= o.fromSequence) && (!o.issueKey || r.issueKey === o.issueKey))
      .slice(0, o.limit)
      .map(clone);
  }

  async insertConflict(c: Conflict) {
    this.conflicts.set(c.id, clone(c));
  }
  async getConflict(id: string) {
    const c = this.conflicts.get(id);
    return c ? clone(c) : null;
  }
  async updateConflict(c: Conflict) {
    if (!this.conflicts.has(c.id)) throw new DomainError('Conflict not found.', 'NOT_FOUND');
    this.conflicts.set(c.id, clone(c));
  }
  async listConflicts(f: { status?: Conflict['status']; ownerDecisionIds?: string[]; issueKey?: string; limit: number }) {
    return [...this.conflicts.values()]
      .filter((c) => !f.status || c.status === f.status)
      .filter((c) => !f.ownerDecisionIds || f.ownerDecisionIds.includes(c.decisionId))
      .filter((c) => !f.issueKey || c.issueKey === f.issueKey)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, f.limit)
      .map(clone);
  }
}
