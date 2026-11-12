import { DomainError } from '../domain/lifecycle';
import { parseDecisionDraft } from '../domain/validate';
import type { Decision, Verdict, WorkItem } from '../domain/types';
import { runCheck } from './checks';
import type { Deps } from './context';

/**
 * One-click demo data so a judge or a new admin sees value in minutes:
 * three decisions owned by the person seeding, three issues that exercise them,
 * and a recorded check for each issue.
 */

export interface DemoIssueInput {
  projectKey: string;
  summary: string;
  description: string;
  labels: string[];
}

/** The slice of Jira the seeder needs; the Forge adapter implements it, tests fake it. */
export interface DemoJira {
  createIssue(input: DemoIssueInput): Promise<string>;
}

export interface DemoResult {
  decisions: Pick<Decision, 'id' | 'title'>[];
  issues: { key: string; summary: string; verdict: Verdict }[];
}

const PROJECT_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;

function demoDrafts(projectKey: string, owner: string) {
  return [
    {
      title: 'No direct card storage in payments',
      statement: 'Our services never store card numbers. Card data goes straight to the payment provider vault; we keep only tokens.',
      rationale: 'Keeps us out of full PCI DSS scope and limits breach impact.',
      ownerAccountId: owner,
      enforcement: 'block',
      scope: { projectKeys: [projectKey] },
      constraints: [{ kind: 'forbid_terms', terms: ['store card', 'card number', 'raw PAN'] }],
    },
    {
      title: 'No Friday afternoon releases',
      statement: 'Work is not moved to Done after 12:00 on Fridays (London time).',
      rationale: 'Releases need a full working day of cover afterwards.',
      ownerAccountId: owner,
      enforcement: 'block',
      scope: { projectKeys: [projectKey] },
      constraints: [{ kind: 'restrict_transition', toStatuses: ['Done'], window: { days: [5], fromHour: 12, toHour: 23, timezone: 'Europe/London' } }],
    },
    {
      title: 'Security review is never skipped',
      statement: 'Changes are not labelled to bypass security review.',
      rationale: 'Hotfixes caused two incidents last year when review was skipped.',
      ownerAccountId: owner,
      enforcement: 'warn',
      scope: { projectKeys: [projectKey] },
      constraints: [{ kind: 'forbid_labels', labels: ['skip-review'] }],
    },
  ];
}

const DEMO_ISSUES = (projectKey: string): DemoIssueInput[] => [
  {
    projectKey,
    summary: 'Store card numbers to speed up repeat checkout',
    description: 'Save the card number in our customer table so returning customers skip card entry.',
    labels: ['checkout'],
  },
  {
    projectKey,
    summary: 'Add Apple Pay button to checkout',
    description: 'Use the payment provider wallet SDK; no card data touches our servers.',
    labels: ['checkout'],
  },
  {
    projectKey,
    summary: 'Hotfix: raise payment gateway timeout to 30s',
    description: 'Quick config change for the gateway timeout.',
    labels: ['hotfix', 'skip-review'],
  },
];

export async function demoLoaded(deps: Deps): Promise<boolean> {
  return (await deps.store.listDecisions()).some((d) => d.demo);
}

export async function seedDemo(deps: Deps, jira: DemoJira, input: { projectKey: unknown; isAdmin: boolean }, actorAccountId: string): Promise<DemoResult> {
  if (!input.isAdmin) throw new DomainError('Only Jira administrators can load demo data.', 'FORBIDDEN');
  const projectKey = typeof input.projectKey === 'string' ? input.projectKey.trim().toUpperCase() : '';
  if (!PROJECT_KEY.test(projectKey)) throw new DomainError('Enter a Jira project key, for example PAY.', 'INVALID');
  if (await demoLoaded(deps)) throw new DomainError('Demo data is already loaded on this site.', 'CONFLICT');

  const ts = deps.now().toISOString();
  const decisions: Decision[] = demoDrafts(projectKey, actorAccountId).map((raw) => ({
    ...parseDecisionDraft(raw, deps.newId),
    id: deps.newId(),
    status: 'accepted',
    demo: true,
    createdAt: ts,
    updatedAt: ts,
    version: 1,
  }));
  for (const d of decisions) await deps.store.insertDecision(d);

  const issues: DemoResult['issues'] = [];
  for (const spec of DEMO_ISSUES(projectKey)) {
    const key = await jira.createIssue(spec);
    const item: WorkItem = { key, projectKey, summary: spec.summary, description: spec.description, labels: spec.labels, components: [], fields: {} };
    const { result } = await runCheck(deps, { type: 'create', actorType: 'human', actorAccountId, item });
    issues.push({ key, summary: spec.summary, verdict: result.verdict });
  }
  return { decisions: decisions.map((d) => ({ id: d.id, title: d.title })), issues };
}
