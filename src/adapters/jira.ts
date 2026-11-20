import api, { route } from '@forge/api';
import type { Decision, WorkItem } from '../domain/types';
import { adfDoc, adfToText } from './adf';
import { confluencePageId, issueNode, pageNode, type Edge } from '../domain/graph';
import type { GraphSource } from '../services/graph';

export type As = 'user' | 'app';
const client = (as: As) => (as === 'user' ? api.asUser() : api.asApp());

const BASE_FIELDS = ['summary', 'description', 'labels', 'components', 'status', 'issuetype', 'project'];

export class JiraError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Custom fields referenced by require_field constraints, so we fetch only what we need. */
export function requiredFieldIds(decisions: Decision[]): string[] {
  const ids = new Set<string>();
  for (const d of decisions) for (const c of d.constraints) if (c.kind === 'require_field') ids.add(c.field);
  return [...ids].filter((f) => /^[a-zA-Z0-9_]+$/.test(f));
}

interface RawIssue {
  key: string;
  fields: Record<string, unknown> & {
    summary?: string;
    description?: unknown;
    labels?: string[];
    components?: { name: string }[];
    status?: { name: string };
    issuetype?: { name: string };
    project?: { key: string };
  };
}

export function toWorkItem(issue: RawIssue, overrides: Record<string, unknown> = {}): WorkItem {
  const f = { ...issue.fields, ...overrides } as RawIssue['fields'];
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) if (!BASE_FIELDS.includes(k)) fields[k] = v;
  return {
    key: issue.key,
    projectKey: f.project?.key ?? issue.key.split('-')[0],
    issueType: f.issuetype?.name,
    summary: f.summary ?? '',
    description: adfToText(f.description ?? ''),
    labels: Array.isArray(f.labels) ? f.labels : [],
    components: Array.isArray(f.components) ? f.components.map((c) => c.name) : [],
    status: f.status?.name,
    fields,
  };
}

export async function fetchWorkItem(issueKey: string, extraFields: string[], as: As, overrides?: Record<string, unknown>): Promise<WorkItem> {
  const fields = [...BASE_FIELDS, ...extraFields].join(',');
  const res = await client(as).requestJira(route`/rest/api/3/issue/${issueKey}?fields=${fields}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new JiraError(`Could not read ${issueKey} (HTTP ${res.status}).`, res.status);
  return toWorkItem((await res.json()) as RawIssue, overrides);
}

/**
 * Validator `modifiedFields` arrive in REST v3 shape; cleared arrays arrive as null.
 * Normalise them so they can override the stored issue fields.
 */
export function normaliseModifiedFields(modified: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(modified ?? {})) out[k] = v === null && (k === 'labels' || k === 'components') ? [] : v;
  return out;
}

const statusCache = new Map<string, string>();

export async function statusName(statusId: string): Promise<string | undefined> {
  const cached = statusCache.get(statusId);
  if (cached) return cached;
  const res = await api.asApp().requestJira(route`/rest/api/3/status/${statusId}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) return undefined;
  const name = ((await res.json()) as { name?: string }).name;
  if (name) statusCache.set(statusId, name);
  return name;
}

/** Comment on the issue, mentioning the decision owner so they are notified by Jira. */
export async function notifyOwnerOnIssue(issueKey: string, ownerAccountId: string, decisionTitle: string, message: string): Promise<void> {
  const body = adfDoc([
    [{ mention: ownerAccountId }, { text: ` This work conflicts with your decision "${decisionTitle}". ${message}` }],
    [{ text: 'Review it in the DecisionGraph panel on this issue.' }],
  ]);
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) console.warn(`notifyOwnerOnIssue: HTTP ${res.status} for ${issueKey}`);
}

/** True when the current user is a Jira administrator. */
export async function isJiraAdmin(): Promise<boolean> {
  const res = await api.asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return false;
  const body = (await res.json()) as { permissions?: { ADMINISTER?: { havePermission?: boolean } } };
  return body.permissions?.ADMINISTER?.havePermission === true;
}

interface IssueTypeMeta {
  id: string;
  name: string;
  subtask?: boolean;
}

const PREFERRED_TYPES = ['task', 'story', 'bug'];

/** Pick a standard issue type for the project, preferring Task, then Story, then Bug. */
export function chooseIssueType(types: IssueTypeMeta[]): IssueTypeMeta | undefined {
  const standard = types.filter((t) => !t.subtask);
  for (const name of PREFERRED_TYPES) {
    const hit = standard.find((t) => t.name.toLowerCase() === name);
    if (hit) return hit;
  }
  return standard[0];
}

/** Jira implementation of the demo seeder's port. Issues are created as the admin who seeds. */
export const forgeDemoJira = {
  async createIssue(input: { projectKey: string; summary: string; description: string; labels: string[] }): Promise<string> {
    const metaRes = await api.asUser().requestJira(route`/rest/api/3/issue/createmeta/${input.projectKey}/issuetypes`, {
      headers: { Accept: 'application/json' },
    });
    if (!metaRes.ok) throw new JiraError(`Can't create issues in ${input.projectKey} (HTTP ${metaRes.status}). Check the key and your permissions.`, metaRes.status);
    const meta = (await metaRes.json()) as { issueTypes?: IssueTypeMeta[]; values?: IssueTypeMeta[] };
    const type = chooseIssueType(meta.issueTypes ?? meta.values ?? []);
    if (!type) throw new JiraError(`${input.projectKey} has no issue type the demo can use.`, 400);

    const create = async (withLabels: boolean) =>
      api.asUser().requestJira(route`/rest/api/3/issue`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            project: { key: input.projectKey },
            issuetype: { id: type.id },
            summary: input.summary,
            description: adfDoc([[{ text: input.description }]]),
            ...(withLabels ? { labels: input.labels } : {}),
          },
        }),
      });
    let res = await create(true);
    // Some create screens don't include labels; retry without rather than failing the demo.
    if (res.status === 400) res = await create(false);
    if (!res.ok) throw new JiraError(`Could not create a demo issue in ${input.projectKey} (HTTP ${res.status}).`, res.status);
    return ((await res.json()) as { key: string }).key;
  },
};

/** Port used by impact analysis: list open work matching a JQL query, up to a cap. */
export interface WorkSearch {
  search(jql: string, extraFields: string[], cap: number): Promise<{ items: WorkItem[]; truncated: boolean }>;
}

const PAGE = 100;

/**
 * Enhanced JQL search (POST /rest/api/3/search/jql), paged by nextPageToken.
 * Stops on a repeated token, a known failure mode of this endpoint.
 */
function makeWorkSearch(as: As): WorkSearch {
  return {
    async search(jql, extraFields, cap) {
      const items: WorkItem[] = [];
      const seen = new Set<string>();
      let token: string | undefined;
      for (let page = 0; page < 20; page++) {
        const res = await client(as).requestJira(route`/rest/api/3/search/jql`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jql,
            fields: [...BASE_FIELDS, ...extraFields],
            maxResults: Math.min(PAGE, cap - items.length),
            ...(token ? { nextPageToken: token } : {}),
          }),
        });
        if (!res.ok) throw new JiraError(`Jira search failed (HTTP ${res.status}).`, res.status);
        const body = (await res.json()) as { issues?: RawIssue[]; nextPageToken?: string; isLast?: boolean };
        for (const issue of body.issues ?? []) items.push(toWorkItem(issue));
        if (items.length >= cap) return { items: items.slice(0, cap), truncated: true };
        if (body.isLast || !body.nextPageToken || seen.has(body.nextPageToken)) return { items, truncated: false };
        seen.add(body.nextPageToken);
        token = body.nextPageToken;
      }
      return { items, truncated: true };
    },
  };
}

/** Runs as the user, so people only see impact on work they can see. */
export const forgeWorkSearch: WorkSearch = makeWorkSearch('user');
/** Runs as the app, for background graph refresh. */
export const appWorkSearch: WorkSearch = makeWorkSearch('app');


// ---------- Graph source ----------

interface RawLinks {
  key: string;
  fields: {
    parent?: { key: string };
    issuelinks?: {
      type: { name: string; inward: string; outward: string };
      inwardIssue?: { key: string };
      outwardIssue?: { key: string };
    }[];
  };
}

interface RawRemoteLink {
  globalId?: string;
  application?: { type?: string; name?: string };
  object?: { url?: string; title?: string };
}

/** Pure mapping from Jira's issue and remote-link payloads to graph edges. */
export function edgesFromJira(issue: RawLinks, remote: RawRemoteLink[]): Edge[] {
  const from = issueNode(issue.key);
  const edges: Edge[] = [];
  if (issue.fields.parent?.key) edges.push({ from, to: issueNode(issue.fields.parent.key), type: 'parent' });
  for (const l of issue.fields.issuelinks ?? []) {
    const other = l.outwardIssue?.key ?? l.inwardIssue?.key;
    if (!other) continue;
    const phrase = l.outwardIssue ? l.type.outward : l.type.inward;
    edges.push({ from, to: issueNode(other), type: 'issue_link', linkType: l.type.name, toLabel: phrase });
  }
  for (const r of remote) {
    const isConfluence = r.application?.type === 'com.atlassian.confluence' || /\/wiki\//.test(r.object?.url ?? '');
    if (!isConfluence) continue;
    const pageId = confluencePageId(r.globalId, r.object?.url);
    if (pageId) edges.push({ from, to: pageNode(pageId), type: 'page_link', ...(r.object?.title ? { toLabel: r.object.title } : {}) });
  }
  // Deduplicate on (to, type): the table's key.
  const seen = new Set<string>();
  return edges.filter((e) => {
    const k = `${e.to}|${e.type}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const forgeGraphSource: GraphSource = {
  async issueEdges(keyOrId) {
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${keyOrId}?fields=parent,issuelinks`, { headers: { Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new JiraError(`Could not read links of ${keyOrId} (HTTP ${res.status}).`, res.status);
    const issue = (await res.json()) as RawLinks;
    const rl = await api.asApp().requestJira(route`/rest/api/3/issue/${issue.key}/remotelink`, { headers: { Accept: 'application/json' } });
    const remote = rl.ok ? ((await rl.json()) as RawRemoteLink[]) : [];
    return { key: issue.key, edges: edgesFromJira(issue, remote) };
  },
  async recentlyUpdated(days, cap) {
    const d = Math.max(1, Math.min(365, Math.floor(days)));
    const { items } = await appWorkSearch.search(`updated >= -${d}d ORDER BY updated DESC`, [], cap);
    return items.map((i) => i.key).filter((k): k is string => Boolean(k));
  },
};

// ---------- Actor identity ----------

export interface AccountInfo {
  accountId: string;
  accountType: string;
  displayName: string;
  active: boolean;
}

const accountCache = new Map<string, AccountInfo | null>();

/** Account type, name and active flag for an account id (cached per function runtime). */
export async function accountInfo(accountId: string | undefined): Promise<AccountInfo | null> {
  if (!accountId) return null;
  if (accountCache.has(accountId)) return accountCache.get(accountId) ?? null;
  let info: AccountInfo | null = null;
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/user?accountId=${accountId}`, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const b = (await res.json()) as { accountId: string; accountType?: string; displayName?: string; active?: boolean };
      info = { accountId: b.accountId, accountType: b.accountType ?? 'atlassian', displayName: b.displayName ?? '', active: b.active !== false };
    }
  } catch (e) {
    console.warn(`accountInfo failed: ${(e as Error).message}`);
  }
  accountCache.set(accountId, info);
  return info;
}

/**
 * Classify who acted. Agents that run under their own account (Rovo agent accounts, other apps)
 * and Jira Automation show up as `app` accounts. An agent acting under a person's account cannot be
 * told apart from that person here; the check-plan action covers agents that ask first.
 */
export function classifyActor(info: AccountInfo | null): { actorType: 'human' | 'rovo_agent' | 'automation'; actorName?: string } {
  if (!info || info.accountType !== 'app') return { actorType: 'human' };
  if (/automation/i.test(info.displayName)) return { actorType: 'automation', actorName: info.displayName };
  return { actorType: 'rovo_agent', actorName: info.displayName || 'App or agent account' };
}
