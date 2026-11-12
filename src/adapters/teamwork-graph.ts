import api from '@forge/api';

/**
 * Teamwork Graph enrichment (EAP). Used only to add context: which teams the decision owner
 * belongs to, and who owns the source page. Every call is optional: if the API is unavailable,
 * not allowlisted, rate-limited or the scopes are missing, we return empty results and the
 * product keeps working on Jira and Confluence data alone.
 *
 * Calls run as the current user (the API does not support asApp), so results are filtered
 * to what that user can see.
 *
 * NOTE: the node fields below follow the curated-query docs. Confirm them against the live
 * schema on your development site (TWG playground) before relying on them in a demo.
 */

const USER_TEAMS = `query decisiongraph_ownerTeams($userId: ID!) {
  atlassianUserInTeams(userId: $userId, first: 10) {
    edges { node { __typename ... on AtlassianTeam { id displayName } } }
  }
}`;

const PAGE_OWNERS = `query decisiongraph_pageOwners($pageId: ID!) {
  confluencePageOwners(id: $pageId, first: 5) {
    edges { node { __typename ... on AtlassianUser { id } } }
  }
}`;

export interface TeamRef {
  id: string;
  name: string;
}

interface GraphResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

type Edges<N> = { edges?: { node?: N | null }[] } | null | undefined;

const userAri = (accountId: string) => `ari:cloud:identity::user/${accountId}`;

async function query<T>(q: string, variables: Record<string, unknown>, operationName: string): Promise<T | null> {
  try {
    const res = await api.asUser().requestTeamworkGraph(q, variables, operationName);
    if (!res.ok) return null;
    const body = (await res.json()) as GraphResponse<T>;
    // A missing operation name or scope can return HTTP 200 with errors or silently empty data.
    if (body.errors?.length) {
      console.warn(`TWG ${operationName}: ${body.errors.map((e) => e.message).join('; ')}`);
      return null;
    }
    return body.data ?? null;
  } catch (e) {
    console.warn(`TWG ${operationName} unavailable: ${(e as Error).message}`);
    return null;
  }
}

export async function ownerTeams(ownerAccountId: string): Promise<TeamRef[]> {
  const data = await query<{ atlassianUserInTeams: Edges<{ id?: string; displayName?: string }> }>(
    USER_TEAMS,
    { userId: userAri(ownerAccountId) },
    'decisiongraph_ownerTeams',
  );
  return (data?.atlassianUserInTeams?.edges ?? [])
    .map((e) => e.node)
    .filter((n): n is { id: string; displayName: string } => Boolean(n?.id && n?.displayName))
    .map((n) => ({ id: n.id, name: n.displayName }));
}

/** Account ids of a Confluence page's owners, used to suggest a decision owner. */
export async function pageOwnerAccountIds(pageAri: string): Promise<string[]> {
  const data = await query<{ confluencePageOwners: Edges<{ id?: string }> }>(PAGE_OWNERS, { pageId: pageAri }, 'decisiongraph_pageOwners');
  return (data?.confluencePageOwners?.edges ?? [])
    .map((e) => e.node?.id)
    .filter((id): id is string => Boolean(id))
    .map((ari) => ari.split('/').pop() ?? ari);
}
