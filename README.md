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
| Issue events | `trigger` | Create and edit can't be blocked, so conflicts are recorded and the owner is @mentioned |
| Confluence macro "Decision record" | `macro` | Record, accept, supersede or retire decisions on the page where they were made; owner suggested via Teamwork Graph |
| Global page "DecisionGraph" | `jira:globalPage` | Owner review queue, decision register, activity and audit verification |
| Rovo agent "Decision Keeper" | `rovo:agent` + `action` | Checks plans before acting; drafts decisions (never accepts them) |
| MCP tools | `rovo:mcp` | `check-plan-tool`, `list-decisions`, `explain-decision` for Claude, Cursor and other external agents |

## Rule types

`forbid_terms` · `forbid_labels` · `forbid_components` · `restrict_transition` (optional freeze window, timezone-aware, wraps midnight) · `require_field`

Only `accepted` decisions are enforced. Each decision is `warn` or `block`.

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
npm run check            # typecheck + 37 unit tests
npm run lint:manifest    # offline manifest schema check

forge login
forge register           # writes your app id into manifest.yml
forge deploy
forge install --product jira --site <your-site>.atlassian.net
forge install --product confluence --site <your-site>.atlassian.net --upgrade
```

Then:
1. In Jira, open **Apps → DecisionGraph** and record a decision (or add the **Decision record** macro on a Confluence page).
2. Add the **DecisionGraph decision check** validator to the transitions you want guarded (company-managed workflows).
3. For external agents: in Atlassian Administration → Connected apps, enable the DecisionGraph MCP tools. The endpoint is `https://mcp.atlassian.com/forge/<appId>`.

## Known limits (check on your dev site)

- **Teamwork Graph API is EAP.** The docs say apps calling it should only be installed in test organisations. It is used only for enrichment (owner's teams, page owners) and fails soft. Confirm the node fields in `src/adapters/teamwork-graph.ts` against the live schema in the TWG playground.
- **Workflow validators** apply to company-managed project workflows.
- Issue create/edit can't be blocked by Forge, only flagged.

## Tests

```bash
npm test
```

The tests cover the engine (term matching, scope, freeze windows across timezones and midnight, exceptions and expiry), the lifecycle (owner-only changes, supersession history), input validation (untrusted UI and LLM input), receipt chain tamper/deletion/reorder detection, the service flows (dedupe of conflicts, exceptions, withdrawals, concurrent receipt writes, supersede rollback), self-healing migrations and Jira mapping.
