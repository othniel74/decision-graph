import type { Connection, Decision } from './types';
import { reachOf } from './engine';

/**
 * The decision graph: work items and Confluence pages, joined by the links teams already make.
 * Pure: edges are passed in; storage and refresh live elsewhere.
 *
 * Node ids: `issue:PAY-7`, `page:123456`.
 */

export type EdgeType = 'parent' | 'page_link' | 'issue_link';

export interface Edge {
  from: string;
  to: string;
  type: EdgeType;
  /** For issue links: the link name as Jira shows it, e.g. "blocks", "relates to". */
  linkType?: string;
  /** Readable label: a page's title, or an issue link's phrase such as "is blocked by". */
  toLabel?: string;
}

export interface GraphPolicy {
  /** How many links away from the work a decision's page may be. */
  maxHops: number;
  /** Issue link names that carry decisions across (case-insensitive). Others are ignored. */
  strongIssueLinks: string[];
}

export const DEFAULT_POLICY: GraphPolicy = { maxHops: 2, strongIssueLinks: [] };

export type OverrideState = 'confirmed' | 'excluded' | 'reported';

/** A person's judgement about whether a decision should reach a work item through the graph. */
export interface PathOverride {
  decisionId: string;
  issueKey: string;
  state: OverrideState;
  byAccountId: string;
  note?: string;
  at: string;
}

export const issueNode = (key: string) => `issue:${key}`;
export const pageNode = (id: string) => `page:${id}`;
const isIssue = (n: string) => n.startsWith('issue:');
const pageIdOf = (n: string) => (n.startsWith('page:') ? n.slice(5) : null);
const keyOf = (n: string) => n.slice(6);

/** Whether an edge may carry a decision. Parent and page links always; issue links only if named strong. */
export function isStrong(e: Edge, policy: GraphPolicy): boolean {
  if (e.type !== 'issue_link') return true;
  const names = policy.strongIssueLinks.map((s) => s.trim().toLowerCase());
  return e.linkType !== undefined && names.includes(e.linkType.trim().toLowerCase());
}

export function stepLabel(e: Edge): string {
  switch (e.type) {
    case 'parent':
      return `parent ${keyOf(e.to)}`;
    case 'issue_link':
      return `${e.toLabel ?? e.linkType ?? 'linked to'} ${keyOf(e.to)}`;
    case 'page_link':
      return `page "${e.toLabel ?? pageIdOf(e.to)}"`;
  }
}

/**
 * Breadth-first search from a work item over strong edges, up to maxHops. Pages are end points
 * (we do not walk from a page to other work). Returns the shortest readable path to each page.
 * Deterministic: edges are visited in a stable order.
 */
export function pagesReachable(startKey: string, edges: Edge[], policy: GraphPolicy = DEFAULT_POLICY): Map<string, string[]> {
  const out = new Map<string, Edge[]>();
  for (const e of [...edges].sort((a, b) => a.from.localeCompare(b.from) || a.type.localeCompare(b.type) || a.to.localeCompare(b.to))) {
    if (!isStrong(e, policy)) continue;
    out.set(e.from, [...(out.get(e.from) ?? []), e]);
  }
  const start = issueNode(startKey);
  const result = new Map<string, string[]>();
  const seen = new Set([start]);
  let frontier: { node: string; path: string[] }[] = [{ node: start, path: [startKey] }];
  for (let hop = 0; hop < policy.maxHops && frontier.length; hop++) {
    const next: typeof frontier = [];
    for (const { node, path } of frontier) {
      for (const e of out.get(node) ?? []) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        const p = [...path, stepLabel(e)];
        const pid = pageIdOf(e.to);
        if (pid) result.set(pid, p);
        else if (isIssue(e.to)) next.push({ node: e.to, path: p });
      }
    }
    frontier = next;
  }
  return result;
}

/**
 * Turn reachable pages into connections for decisions recorded on those pages,
 * honouring owner overrides: excluded paths drop out, confirmed ones may block.
 * "Reported" is feedback for the owner and changes nothing on its own.
 */
export function connectionsFor(
  decisions: Decision[],
  pages: Map<string, string[]>,
  issueKey: string,
  overrides: PathOverride[],
): Map<string, Connection> {
  const result = new Map<string, Connection>();
  for (const d of decisions) {
    if (!d.sourcePageId || reachOf(d) === 'scope') continue;
    const path = pages.get(d.sourcePageId);
    if (!path) continue;
    const o = overrides.find((x) => x.decisionId === d.id && x.issueKey === issueKey);
    if (o?.state === 'excluded') continue;
    result.set(d.id, { path, confirmed: o?.state === 'confirmed' });
  }
  return result;
}

/**
 * The reverse of pagesReachable: which work items reach a page within maxHops over strong edges,
 * with the same readable path a forward search would give. Used for impact analysis.
 * `edgesTo(nodes)` returns edges whose `to` is one of the nodes.
 */
export async function issuesReaching(
  pageId: string,
  edgesTo: (nodes: string[]) => Promise<Edge[]>,
  policy: GraphPolicy = DEFAULT_POLICY,
  cap = 500,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  // tails[node] = readable path from node onwards (excluding node itself)
  let frontier = new Map<string, string[]>([[pageNode(pageId), []]]);
  const seen = new Set(frontier.keys());
  for (let hop = 0; hop < policy.maxHops && frontier.size && result.size < cap; hop++) {
    const edges = (await edgesTo([...frontier.keys()])).filter((e) => isStrong(e, policy) && isIssue(e.from));
    edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    const next = new Map<string, string[]>();
    for (const e of edges) {
      if (seen.has(e.from)) continue;
      seen.add(e.from);
      const tail = [stepLabel(e), ...(frontier.get(e.to) ?? [])];
      result.set(keyOf(e.from), [keyOf(e.from), ...tail]);
      next.set(e.from, tail);
      if (result.size >= cap) break;
    }
    frontier = next;
  }
  return result;
}

/** Nodes one hop out that are worth expanding (issues only; pages are end points). */
export function nextIssueNodes(edges: Edge[], policy: GraphPolicy = DEFAULT_POLICY): string[] {
  return [...new Set(edges.filter((e) => isStrong(e, policy) && isIssue(e.to)).map((e) => e.to))].sort();
}

export const GRAPH_MAX_AGE_HOURS = 48;

/** The graph is trusted only if fully refreshed recently; otherwise connected matching switches off. */
export function graphIsFresh(refreshedAt: string | null, now: Date, maxAgeHours = GRAPH_MAX_AGE_HOURS): boolean {
  if (!refreshedAt) return false;
  const t = Date.parse(refreshedAt);
  return !Number.isNaN(t) && now.getTime() - t <= maxAgeHours * 3_600_000;
}

/** Extract a Confluence page id from a Jira remote link (globalId "appId=…&pageId=123" or a page URL). */
export function confluencePageId(globalId: string | undefined, url: string | undefined): string | null {
  const fromGlobal = globalId?.match(/(?:^|&)pageId=(\d+)/)?.[1];
  if (fromGlobal) return fromGlobal;
  if (!url) return null;
  return url.match(/[?&]pageId=(\d+)/)?.[1] ?? url.match(/\/wiki\/.*?\/pages\/(\d+)/)?.[1] ?? null;
}
