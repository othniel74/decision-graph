import api, { route } from '@forge/api';
import type { Decision, WorkItem } from '../domain/types';
import { adfDoc, adfToText } from './adf';

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
