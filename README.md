# DecisionGraph

**Your team's decisions, enforced.** No person or AI agent quietly contradicts what's already been decided.

Teams record decisions in Confluence, then forget them. Months later someone, or now an agent, does the opposite. Existing decision-log apps *record* decisions. DecisionGraph *keeps work consistent with them*:

1. **Record:** a decision becomes a structured record with an owner, a scope and enforceable rules (Confluence macro, global page, or drafted by the Rovo agent).
2. **Check:** every Jira transition, issue change, Rovo agent plan and external MCP agent plan is checked against accepted decisions. The checks are deterministic, with no LLM in the decision path.
3. **Resolve:** conflicts go to the decision owner, who upholds the decision, grants an exception for one issue, or supersedes the decision.
4. **Prove:** every check writes a SHA-256 hash-chained receipt that anyone can verify from the Activity tab.

Built for **Codegeist 2026**, in the *Apps for Software Teams* category.

## Surfaces

| Surface | Module | What it does |
|---|---|---|
| Issue panel "Decisions" | `jira:issuePanel` | Live verdict, violations with evidence and owner (plus owner's teams from Teamwork Graph), exception requests, owner actions |
| Workflow validator | `jira:workflowValidator` | Blocks transitions that break a `block` decision and explains why |
| Issue events | `trigger` | Create and edit can't be blocked, so conflicts are recorded and the owner is @mentioned; links refreshed |
| Issue-link events, daily sweep | `trigger`, `scheduledTrigger` | Keep the decision graph current |
| Confluence macro "Decision record" | `macro` | Record, accept, supersede or retire decisions on the page where they were made; owner suggested via Teamwork Graph |
| Global page "DecisionGraph" | `jira:globalPage` | Owner review queue (conflicts and "not relevant" reports), decision register, activity and audit verification, Setup (demo data, linked-work settings, Teamwork Graph switch) |
| Rovo agent "Decision Keeper" | `rovo:agent` + `action` | Checks plans before acting; drafts decisions (never accepts them) |
| MCP tools | `rovo:mcp` | `check-plan-tool`, `list-decisions`, `explain-decision` for Claude, Cursor and other external agents |

## Linked work (the decision graph)

A decision recorded on a Confluence page also applies to work that is **connected** to that page: issues linked to the page, and issues whose parent or epic is linked to it (up to two steps). Issue links such as *Blocks* carry decisions only if an admin names them in **Setup**. The links come from standard Jira data (parent, issue links, Confluence remote links), stored in Forge SQL and refreshed on issue and issue-link events, before the issue panel opens, on install (last 30 days of work) and daily.

Guards against false alarms and inconsistency:

- **Two gates.** A connection only makes a decision relevant; one of its rules must still fire.
- **Inferred matches warn.** A decision reaching work through links only warns, until the owner confirms that link (then it may block). The owner can also exclude it for that issue. Anyone can report a link as not relevant; that is feedback for the owner and changes nothing on its own.
- **Every match explains itself**, e.g. *applies via PAY-7 → parent PAY-12 → page "Payments Architecture"*. Paths are stored on receipts with the graph's refresh time.
- **Stale data never escalates.** If the last full refresh is older than 48 hours, linked matching switches off and only scopes apply.
- **Trial runs.** New decisions can start with a 7-day trial: conflicts are recorded as *would have flagged*, with no blocking or notifications. The owner reviews them and can enforce early.
- **Negation-aware text rules.** "We must not store card numbers" doesn't trigger a *store card* rule; owners can list allowed phrases.

## Impact analysis

For any decision, **Show affected work** (Confluence macro, Decisions register) searches open Jira issues in its scope and lists those that already contradict it, with reasons. **Check impact on open work** in the decision form previews this before a decision is saved or superseded. Searches run as the current user (enhanced JQL search, capped at 200 issues).

## Agents and automations

Each decision can require a person to approve conflicting work done by agents and automations ("co-pilot before autopilot"). People get the decision's normal enforcement; agents get a block. The workflow validator and the issue triggers look up who acted: Rovo agents with their own account, other apps and Jira Automation run as `app` accounts and are recorded by name on every receipt. An agent acting under a person's own account looks like that person here; the Rovo and MCP `check-plan` tools cover agents that ask first.

## Audit evidence and independent approval

Activity → Audit evidence (Jira administrators): every check, verdict and approval for a period, filterable by project, with who acted (person, agent or automation), totals, self-approvals flagged, chain verification and a CSV to copy. Built for SOC 2 CC8.1, ISO 27001 A.8.32 and DORA change-control reviews. CSV cells are protected against spreadsheet formulas.

Independent approval (Setup, on by default): nobody approves an exception for a conflict they raised. If the decision owner raised it, a Jira administrator approves instead.

## Keeping decisions current

Decisions can carry a review date and a "revisit if" condition. When the date passes, the owner sees "Is this still right?" in their review queue: confirm it (next review in six months) or supersede it. It stays enforced meanwhile. Activity lists decisions whose owner has left Jira; the owner or a Jira administrator can hand them to someone else.

## Rule types

`forbid_terms` · `forbid_labels` · `forbid_components` · `restrict_transition` (optional freeze window, timezone-aware, wraps midnight) · `require_field`

Only `accepted` decisions are enforced. Each decision is `warn` or `block`. Every rule shows a plain-English preview, e.g. *Blocks issues in PAY that mention "store card"*.

## Architecture

```
src/domain/     Pure engine: scope matching, rules, verdicts, lifecycle, validation, receipts
src/services/   Use cases over a Store port: decisions, checks, reviews, audit
src/storage/    Store port + Forge SQL implementation (+ in-memory for tests)
src/adapters/   Jira REST, ADF, Teamwork Graph (optional enrichment; degrades to empty)
src/handlers/   Forge entry points: resolvers, validator, triggers, Rovo/MCP actions
src/frontend/   UI Kit: issue panel, Confluence macro, global page
```

Design choices:
- **Runs on Atlassian.** No egress and no external servers. Data stays in Forge SQL.
- **Identity from the Forge context only.** Ownership checks can't be spoofed from the UI.
- **Agents can draft decisions but never accept them.** A human owner always confirms.
- **Concurrency.** Decision updates use optimistic versioning. Receipt sequence collisions retry. Supersession rolls back if the old decision changed underneath.
- **Self-healing schema.** Migrations run on install, hourly, and on first use if a table is missing.
- **Failure mode.** If a check can't run, transitions are allowed by default (`FAIL_MODE=open`). Set `forge variables set FAIL_MODE closed` to block instead.

## Run it

Prerequisites: Node 22+, Forge CLI (`npm i -g @forge/cli`), an Atlassian developer site **with Rovo enabled** (Rovo is paid-only; a free developer site may have no agent chat).

```bash
npm install
npm run check            # typecheck + 84 unit tests
npm run lint:manifest    # offline manifest schema check

forge login
forge register           # writes your app id into manifest.yml
forge deploy
forge install --product jira --site <your-site>.atlassian.net
forge install --product confluence --site <your-site>.atlassian.net --upgrade
```

Then:
1. In Jira, open **Apps → DecisionGraph → Setup**. As a Jira admin, enter a project key and click **Load demo data**: three decisions you own, plus three issues (one blocked, one clear, one warned). Or record your own decision there, or with the **Decision record** macro in Confluence.
2. Add the **DecisionGraph decision check** validator to the transitions you want guarded (company-managed workflows).
3. For external agents: in Atlassian Administration → Connected apps, enable the DecisionGraph MCP tools. The endpoint is `https://mcp.atlassian.com/forge/<appId>`.

## Known limits (check on your dev site)

- Agent detection relies on `accountType: app` from `/rest/api/3/user`; confirm how Rovo agent accounts and Automation appear on your site.

- **Teamwork Graph is off by default.** A Jira admin turns it on in Setup. The API is EAP; the docs say apps calling it should only be installed in test organisations. It is used only for enrichment (owner's teams, page owners) and fails soft. Confirm the node fields in `src/adapters/teamwork-graph.ts` against the live schema in the TWG playground.
- **Workflow validators** apply to company-managed project workflows.
- Issue create/edit can't be blocked by Forge, only flagged.

## Tests

```bash
npm test
```

The tests cover the engine (term matching, scope, freeze windows across timezones and midnight, exceptions and expiry), the lifecycle (owner-only changes, supersession history), input validation (untrusted UI and LLM input), receipt chain tamper/deletion/reorder detection, the service flows (dedupe of conflicts, exceptions, withdrawals, concurrent receipt writes, supersede rollback), self-healing migrations and Jira mapping.
