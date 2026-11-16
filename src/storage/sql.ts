import { sql, migrationRunner, ForgeSQLAPIError } from '@forge/sql';
import { DomainError } from '../domain/lifecycle';
import type { Decision, DecisionException } from '../domain/types';
import type { Receipt } from '../domain/receipt';
import type { Edge, PathOverride } from '../domain/graph';
import type { Conflict, DecisionFilter, Store } from './store';

/**
 * Forge SQL store. Each table keeps the full record as JSON in `body`, plus the
 * columns we filter or sort on. This keeps schema changes cheap while the domain evolves.
 */

const MIGRATIONS: [string, string][] = [
  [
    'v001_decisions',
    `CREATE TABLE IF NOT EXISTS decisions (
      id VARCHAR(64) PRIMARY KEY,
      status VARCHAR(16) NOT NULL,
      owner_account_id VARCHAR(128) NOT NULL,
      source_page_id VARCHAR(64) NULL,
      version INT NOT NULL,
      updated_at VARCHAR(32) NOT NULL,
      body LONGTEXT NOT NULL,
      INDEX idx_decisions_status (status),
      INDEX idx_decisions_owner (owner_account_id),
      INDEX idx_decisions_page (source_page_id)
    )`,
  ],
  [
    'v002_exceptions',
    `CREATE TABLE IF NOT EXISTS decision_exceptions (
      id VARCHAR(64) PRIMARY KEY,
      decision_id VARCHAR(64) NOT NULL,
      issue_key VARCHAR(64) NOT NULL,
      created_at VARCHAR(32) NOT NULL,
      body LONGTEXT NOT NULL,
      INDEX idx_exc_issue (issue_key),
      INDEX idx_exc_decision (decision_id)
    )`,
  ],
  [
    'v003_receipts',
    `CREATE TABLE IF NOT EXISTS receipts (
      sequence BIGINT PRIMARY KEY,
      id VARCHAR(64) NOT NULL,
      issue_key VARCHAR(64) NULL,
      created_at VARCHAR(32) NOT NULL,
      body LONGTEXT NOT NULL,
      UNIQUE INDEX idx_receipts_id (id),
      INDEX idx_receipts_issue (issue_key)
    )`,
  ],
  [
    'v004_conflicts',
    `CREATE TABLE IF NOT EXISTS conflicts (
      id VARCHAR(64) PRIMARY KEY,
      decision_id VARCHAR(64) NOT NULL,
      issue_key VARCHAR(64) NULL,
      status VARCHAR(16) NOT NULL,
      created_at VARCHAR(32) NOT NULL,
      body LONGTEXT NOT NULL,
      INDEX idx_conf_status (status),
      INDEX idx_conf_decision (decision_id),
      INDEX idx_conf_issue (issue_key)
    )`,
  ],
  [
    'v005_settings',
    `CREATE TABLE IF NOT EXISTS settings (
      setting_key VARCHAR(64) PRIMARY KEY,
      setting_value VARCHAR(1024) NOT NULL,
      updated_at VARCHAR(32) NOT NULL
    )`,
  ],
  [
    'v006_edges',
    `CREATE TABLE IF NOT EXISTS graph_edges (
      from_node VARCHAR(160) NOT NULL,
      to_node VARCHAR(160) NOT NULL,
      edge_type VARCHAR(16) NOT NULL,
      link_type VARCHAR(100) NULL,
      to_label VARCHAR(255) NULL,
      updated_at VARCHAR(32) NOT NULL,
      PRIMARY KEY (from_node, to_node, edge_type),
      INDEX idx_edges_to (to_node)
    )`,
  ],
  [
    'v007_path_overrides',
    `CREATE TABLE IF NOT EXISTS path_overrides (
      decision_id VARCHAR(64) NOT NULL,
      issue_key VARCHAR(64) NOT NULL,
      state VARCHAR(16) NOT NULL,
      body LONGTEXT NOT NULL,
      PRIMARY KEY (decision_id, issue_key),
      INDEX idx_overrides_issue (issue_key)
    )`,
  ],
];

export async function runMigrations(): Promise<string[]> {
  let runner = migrationRunner;
  for (const [name, ddl] of MIGRATIONS) runner = runner.enqueue(name, ddl);
  return runner.run();
}

function isDuplicate(err: unknown): boolean {
  const msg = err instanceof ForgeSQLAPIError || err instanceof Error ? err.message : String(err);
  return /duplicate entry/i.test(msg);
}

type BodyRow = { body: string };
const parse = <T>(rows: BodyRow[]): T[] => rows.map((r) => JSON.parse(r.body) as T);

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

const clampLimit = (n: number): number => Math.max(1, Math.min(500, Math.floor(n)));

export class SqlStore implements Store {
  async listDecisions(f: DecisionFilter = {}): Promise<Decision[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.statuses?.length) {
      where.push(`status IN (${placeholders(f.statuses.length)})`);
      params.push(...f.statuses);
    }
    if (f.ownerAccountId) {
      where.push('owner_account_id = ?');
      params.push(f.ownerAccountId);
    }
    if (f.sourcePageId) {
      where.push('source_page_id = ?');
      params.push(f.sourcePageId);
    }
    const q = `SELECT body FROM decisions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT 1000`;
    const res = await sql.prepare<BodyRow>(q).bindParams(...params).execute();
    return parse<Decision>(res.rows);
  }

  async getDecision(id: string): Promise<Decision | null> {
    const res = await sql.prepare<BodyRow>('SELECT body FROM decisions WHERE id = ?').bindParams(id).execute();
    return parse<Decision>(res.rows)[0] ?? null;
  }

  async insertDecision(d: Decision): Promise<void> {
    try {
      await sql
        .prepare('INSERT INTO decisions (id, status, owner_account_id, source_page_id, version, updated_at, body) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bindParams(d.id, d.status, d.ownerAccountId, d.sourcePageId ?? null, d.version, d.updatedAt, JSON.stringify(d))
        .execute();
    } catch (e) {
      if (isDuplicate(e)) throw new DomainError('Decision already exists.', 'CONFLICT');
      throw e;
    }
  }

  async updateDecision(d: Decision, expectedVersion: number): Promise<void> {
    const res = await sql
      .prepare<import('@forge/sql').UpdateQueryResponse>(
        'UPDATE decisions SET status = ?, owner_account_id = ?, source_page_id = ?, version = ?, updated_at = ?, body = ? WHERE id = ? AND version = ?',
      )
      .bindParams(d.status, d.ownerAccountId, d.sourcePageId ?? null, d.version, d.updatedAt, JSON.stringify(d), d.id, expectedVersion)
      .execute();
    if (res.rows.affectedRows === 0) {
      const exists = await this.getDecision(d.id);
      if (!exists) throw new DomainError('Decision not found.', 'NOT_FOUND');
      throw new DomainError('Decision was changed by someone else. Reload and try again.', 'CONFLICT');
    }
  }

  async listExceptions(f: { issueKey?: string; decisionId?: string }): Promise<DecisionException[]> {
    const where: string[] = [];
    const params: string[] = [];
    if (f.issueKey) {
      where.push('issue_key = ?');
      params.push(f.issueKey);
    }
    if (f.decisionId) {
      where.push('decision_id = ?');
      params.push(f.decisionId);
    }
    const q = `SELECT body FROM decision_exceptions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 500`;
    const res = await sql.prepare<BodyRow>(q).bindParams(...params).execute();
    return parse<DecisionException>(res.rows);
  }

  async insertException(e: DecisionException): Promise<void> {
    await sql
      .prepare('INSERT INTO decision_exceptions (id, decision_id, issue_key, created_at, body) VALUES (?, ?, ?, ?, ?)')
      .bindParams(e.id, e.decisionId, e.issueKey, e.createdAt, JSON.stringify(e))
      .execute();
  }

  async latestReceipt(): Promise<Receipt | null> {
    const res = await sql.executeRaw<BodyRow>('SELECT body FROM receipts ORDER BY sequence DESC LIMIT 1');
    return parse<Receipt>(res.rows)[0] ?? null;
  }

  async insertReceipt(r: Receipt): Promise<void> {
    try {
      await sql
        .prepare('INSERT INTO receipts (sequence, id, issue_key, created_at, body) VALUES (?, ?, ?, ?, ?)')
        .bindParams(r.sequence, r.id, r.issueKey ?? null, r.createdAt, JSON.stringify(r))
        .execute();
    } catch (e) {
      if (isDuplicate(e)) throw new DomainError('Receipt sequence taken.', 'CONFLICT');
      throw e;
    }
  }

  async listReceipts(o: { fromSequence?: number; limit: number; issueKey?: string }): Promise<Receipt[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (o.fromSequence !== undefined) {
      where.push('sequence >= ?');
      params.push(o.fromSequence);
    }
    if (o.issueKey) {
      where.push('issue_key = ?');
      params.push(o.issueKey);
    }
    const q = `SELECT body FROM receipts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY sequence ASC LIMIT ${clampLimit(o.limit)}`;
    const res = await sql.prepare<BodyRow>(q).bindParams(...params).execute();
    return parse<Receipt>(res.rows);
  }

  async insertConflict(c: Conflict): Promise<void> {
    await sql
      .prepare('INSERT INTO conflicts (id, decision_id, issue_key, status, created_at, body) VALUES (?, ?, ?, ?, ?, ?)')
      .bindParams(c.id, c.decisionId, c.issueKey ?? null, c.status, c.createdAt, JSON.stringify(c))
      .execute();
  }

  async getConflict(id: string): Promise<Conflict | null> {
    const res = await sql.prepare<BodyRow>('SELECT body FROM conflicts WHERE id = ?').bindParams(id).execute();
    return parse<Conflict>(res.rows)[0] ?? null;
  }

  async updateConflict(c: Conflict): Promise<void> {
    await sql
      .prepare('UPDATE conflicts SET status = ?, body = ? WHERE id = ?')
      .bindParams(c.status, JSON.stringify(c), c.id)
      .execute();
  }

  async getSetting(key: string): Promise<string | null> {
    const res = await sql
      .prepare<{ setting_value: string }>('SELECT setting_value FROM settings WHERE setting_key = ?')
      .bindParams(key)
      .execute();
    return res.rows[0]?.setting_value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await sql
      .prepare('INSERT INTO settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = VALUES(updated_at)')
      .bindParams(key, value, new Date().toISOString())
      .execute();
  }

  async replaceEdgesFrom(from: string, edges: Edge[], at: string): Promise<void> {
    if (edges.some((e) => e.from !== from)) throw new DomainError('Edge does not start at the replaced node.', 'INVALID');
    // No transactions in Forge SQL: delete then insert. A reader in between sees fewer edges,
    // which can only make a check quieter, never stricter.
    await sql.prepare('DELETE FROM graph_edges WHERE from_node = ?').bindParams(from).execute();
    for (const e of edges) {
      await sql
        .prepare(
          'INSERT INTO graph_edges (from_node, to_node, edge_type, link_type, to_label, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE link_type = VALUES(link_type), to_label = VALUES(to_label), updated_at = VALUES(updated_at)',
        )
        .bindParams(e.from, e.to, e.type, e.linkType?.slice(0, 100) ?? null, e.toLabel?.slice(0, 255) ?? null, at)
        .execute();
    }
  }

  async listEdgesFrom(nodes: string[]): Promise<Edge[]> {
    if (nodes.length === 0) return [];
    const res = await sql
      .prepare<{ from_node: string; to_node: string; edge_type: Edge['type']; link_type: string | null; to_label: string | null }>(
        `SELECT from_node, to_node, edge_type, link_type, to_label FROM graph_edges WHERE from_node IN (${placeholders(nodes.length)}) LIMIT 2000`,
      )
      .bindParams(...nodes)
      .execute();
    return res.rows.map((r) => ({
      from: r.from_node,
      to: r.to_node,
      type: r.edge_type,
      ...(r.link_type ? { linkType: r.link_type } : {}),
      ...(r.to_label ? { toLabel: r.to_label } : {}),
    }));
  }

  async listEdgesTo(nodes: string[]): Promise<Edge[]> {
    if (nodes.length === 0) return [];
    const res = await sql
      .prepare<{ from_node: string; to_node: string; edge_type: Edge['type']; link_type: string | null; to_label: string | null }>(
        `SELECT from_node, to_node, edge_type, link_type, to_label FROM graph_edges WHERE to_node IN (${placeholders(nodes.length)}) LIMIT 2000`,
      )
      .bindParams(...nodes)
      .execute();
    return res.rows.map((r) => ({
      from: r.from_node,
      to: r.to_node,
      type: r.edge_type,
      ...(r.link_type ? { linkType: r.link_type } : {}),
      ...(r.to_label ? { toLabel: r.to_label } : {}),
    }));
  }

  async listOverrides(f: { issueKey?: string; decisionId?: string }): Promise<PathOverride[]> {
    const where: string[] = [];
    const params: string[] = [];
    if (f.issueKey) {
      where.push('issue_key = ?');
      params.push(f.issueKey);
    }
    if (f.decisionId) {
      where.push('decision_id = ?');
      params.push(f.decisionId);
    }
    const q = `SELECT body FROM path_overrides ${where.length ? `WHERE ${where.join(' AND ')}` : ''} LIMIT 500`;
    const res = await sql.prepare<BodyRow>(q).bindParams(...params).execute();
    return parse<PathOverride>(res.rows);
  }

  async putOverride(o: PathOverride): Promise<void> {
    await sql
      .prepare('INSERT INTO path_overrides (decision_id, issue_key, state, body) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE state = VALUES(state), body = VALUES(body)')
      .bindParams(o.decisionId, o.issueKey, o.state, JSON.stringify(o))
      .execute();
  }

  async listConflicts(f: { status?: Conflict['status']; ownerDecisionIds?: string[]; issueKey?: string; limit: number }): Promise<Conflict[]> {
    if (f.ownerDecisionIds && f.ownerDecisionIds.length === 0) return [];
    const where: string[] = [];
    const params: string[] = [];
    if (f.status) {
      where.push('status = ?');
      params.push(f.status);
    }
    if (f.ownerDecisionIds) {
      where.push(`decision_id IN (${placeholders(f.ownerDecisionIds.length)})`);
      params.push(...f.ownerDecisionIds);
    }
    if (f.issueKey) {
      where.push('issue_key = ?');
      params.push(f.issueKey);
    }
    const q = `SELECT body FROM conflicts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ${clampLimit(f.limit)}`;
    const res = await sql.prepare<BodyRow>(q).bindParams(...params).execute();
    return parse<Conflict>(res.rows);
  }
}
