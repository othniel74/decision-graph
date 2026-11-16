import { DomainError } from '../domain/lifecycle';
import { str } from '../domain/validate';
import { reachOf } from '../domain/engine';
import {
  connectionsFor,
  DEFAULT_POLICY,
  graphIsFresh,
  issueNode,
  nextIssueNodes,
  pagesReachable,
  type Edge,
  type GraphPolicy,
  type OverrideState,
  type PathOverride,
} from '../domain/graph';
import type { Connection, Decision } from '../domain/types';
import type { Deps } from './context';

export const GRAPH_REFRESHED_KEY = 'graph.refreshedAt';
export const STRONG_LINKS_KEY = 'graph.strongIssueLinks';

export async function graphPolicy(deps: Deps): Promise<GraphPolicy> {
  const raw = await deps.store.getSetting(STRONG_LINKS_KEY);
  let strong: string[] = [];
  try {
    const v = raw ? JSON.parse(raw) : [];
    if (Array.isArray(v)) strong = v.filter((x): x is string => typeof x === 'string');
  } catch {
    strong = [];
  }
  return { ...DEFAULT_POLICY, strongIssueLinks: strong };
}

export interface ItemConnections {
  connections: Map<string, Connection>;
  stale: boolean;
  /** When the graph was last fully refreshed, recorded on receipts. */
  graphAt: string | null;
}

const NONE: ItemConnections = { connections: new Map(), stale: false, graphAt: null };

/**
 * Connections from a work item to decisions recorded on Confluence pages, read from the stored graph.
 * Two queries (one per hop). If the graph is out of date, returns stale and no connections, so a
 * check can only get quieter, never stricter.
 */
export async function connectionsForItem(deps: Deps, issueKey: string | undefined, decisions: Decision[]): Promise<ItemConnections> {
  if (!issueKey) return NONE;
  const relevant = decisions.filter((d) => d.status === 'accepted' && d.sourcePageId && reachOf(d) !== 'scope');
  if (relevant.length === 0) return NONE;
  const graphAt = await deps.store.getSetting(GRAPH_REFRESHED_KEY);
  if (!graphIsFresh(graphAt, deps.now())) return { connections: new Map(), stale: true, graphAt };
  const policy = await graphPolicy(deps);
  const hop1 = await deps.store.listEdgesFrom([issueNode(issueKey)]);
  const hop2 = policy.maxHops > 1 ? await deps.store.listEdgesFrom(nextIssueNodes(hop1, policy)) : [];
  const pages = pagesReachable(issueKey, [...hop1, ...hop2], policy);
  const overrides = pages.size ? await deps.store.listOverrides({ issueKey }) : [];
  return { connections: connectionsFor(relevant, pages, issueKey, overrides), stale: false, graphAt };
}

const STATES: OverrideState[] = ['confirmed', 'excluded', 'reported'];

/**
 * Owners confirm (may block) or exclude (stops applying) a connected path for one issue.
 * Anyone may report a path as not relevant; that is feedback for the owner and changes nothing,
 * so nobody can switch off a decision for their own work.
 */
export async function setPathOverride(
  deps: Deps,
  input: { decisionId: unknown; issueKey: unknown; state: unknown; note?: unknown },
  actorAccountId: string,
): Promise<PathOverride> {
  const decisionId = str(input.decisionId, 'decisionId', { max: 64 });
  const issueKey = str(input.issueKey, 'issueKey', { max: 64 }).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(issueKey)) throw new DomainError('issueKey must be a Jira issue key.', 'INVALID');
  const state = input.state as OverrideState;
  if (!STATES.includes(state)) throw new DomainError('state must be confirmed, excluded or reported.', 'INVALID');
  const d = await deps.store.getDecision(decisionId);
  if (!d) throw new DomainError('Decision not found.', 'NOT_FOUND');
  const isOwner = d.ownerAccountId === actorAccountId;
  if (state !== 'reported' && !isOwner) throw new DomainError('Only the decision owner can confirm or exclude a path.', 'FORBIDDEN');
  const note = str(input.note, 'note', { required: state === 'reported', max: 1000 });
  if (state === 'reported') {
    const existing = (await deps.store.listOverrides({ decisionId, issueKey }))[0];
    // A report never replaces the owner's own decision on this path.
    if (existing && existing.state !== 'reported') return existing;
  }
  const o: PathOverride = { decisionId, issueKey, state, byAccountId: actorAccountId, ...(note ? { note } : {}), at: deps.now().toISOString() };
  await deps.store.putOverride(o);
  return o;
}

/** Open reports from people who think a connected decision does not belong on their work. */
export async function reportsForOwner(deps: Deps, ownerAccountId: string): Promise<PathOverride[]> {
  const owned = await deps.store.listDecisions({ ownerAccountId, statuses: ['accepted'] });
  const lists = await Promise.all(owned.map((d) => deps.store.listOverrides({ decisionId: d.id })));
  return lists.flat().filter((o) => o.state === 'reported');
}

// ---------- Refresh ----------

/** Port to Jira for building the graph. The Forge adapter implements it; tests fake it. */
export interface GraphSource {
  /** Outgoing edges of one issue (parent, issue links, Confluence page links). Accepts a key or id. */
  issueEdges(keyOrId: string): Promise<{ key: string; edges: Edge[] } | null>;
  /** Keys of issues updated in the last `days`, newest first, up to `cap`. */
  recentlyUpdated(days: number, cap: number): Promise<string[]>;
}

export async function refreshIssue(deps: Deps, src: GraphSource, keyOrId: string): Promise<{ key: string; edges: Edge[] } | null> {
  const r = await src.issueEdges(keyOrId);
  if (!r) return null;
  await deps.store.replaceEdgesFrom(issueNode(r.key), r.edges, deps.now().toISOString());
  return r;
}

/** Refresh an issue and the issues it links to, so a two-step path is current. Used before showing the panel. */
export async function refreshNeighbourhood(deps: Deps, src: GraphSource, key: string): Promise<void> {
  const r = await refreshIssue(deps, src, key);
  if (!r) return;
  const policy = await graphPolicy(deps);
  const next = nextIssueNodes(r.edges, policy).slice(0, 10).map((n) => n.slice(6));
  await Promise.all(next.map((k) => refreshIssue(deps, src, k)));
}

/**
 * Full refresh of recently changed work. Marks the graph fresh only if every issue refreshed,
 * so a partial failure leaves the old timestamp and the graph goes stale rather than wrong.
 */
export async function sweep(deps: Deps, src: GraphSource, opts: { days: number; cap: number }): Promise<{ refreshed: number; failed: number }> {
  const keys = await src.recentlyUpdated(opts.days, opts.cap);
  let failed = 0;
  for (const k of keys) {
    try {
      await refreshIssue(deps, src, k);
    } catch (e) {
      failed += 1;
      console.warn(`graph sweep: ${k} failed: ${(e as Error).message}`);
    }
  }
  if (failed === 0) await deps.store.setSetting(GRAPH_REFRESHED_KEY, deps.now().toISOString());
  return { refreshed: keys.length - failed, failed };
}
