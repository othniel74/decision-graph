import React, { useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  DynamicTable,
  Heading,
  Inline,
  Lozenge,
  SectionMessage,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textfield,
  Toggle,
  Label,
  HelperMessage,
  User,
  UserPicker,
  xcss,
  CodeBlock,
  DatePicker,
} from '@forge/react';
import type { EvidenceReport } from '../services/evidence';
import type { Decision } from '../domain/types';
import type { Receipt } from '../domain/receipt';
import type { Conflict } from '../storage/store';
import type { HealthSummary } from '../services/audit';
import { DecisionForm } from './decision-form';
import { AffectedWork, TrialPanel } from './impact';
import type { PathOverride } from '../domain/graph';
import { call, DecisionSummary, ErrorBox, Loading, StatusLozenge, useResolver, VerdictLozenge } from './shared';

const tile = xcss({ padding: 'space.150', backgroundColor: 'color.background.neutral', borderRadius: 'radius.medium' });

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <Box xcss={tile}>
      <Stack space="space.050">
        <Heading size="medium">{String(value)}</Heading>
        <Text size="small">{label}</Text>
      </Stack>
    </Box>
  );
}

function ReviewQueue({ me }: { me: string }) {
  const { loading, data: queue, error, reload } = useResolver<{ conflicts: Conflict[]; reports: PathOverride[]; due: Decision[] }>('reviewQueue');
  const [msg, setMsg] = useState<string>();
  const [superseding, setSuperseding] = useState<Decision>();
  if (superseding) {
    return (
      <DecisionForm
        title={`Supersede "${superseding.title}"`}
        me={me}
        defaultOwner={superseding.ownerAccountId}
        supersedes={superseding}
        onDone={() => {
          setSuperseding(undefined);
          void reload();
        }}
        onCancel={() => setSuperseding(undefined)}
      />
    );
  }
  const startSupersede = async (decisionId: string) => {
    const r = await call<{ decision: Decision }>('getDecision', { id: decisionId });
    if (r.ok) setSuperseding(r.data.decision);
    else setMsg(r.error);
  };
  if (loading && !queue) return <Loading what="your review queue" />;
  if (error) return <ErrorBox error={error} />;
  const data = queue?.conflicts ?? [];
  const reports = queue?.reports ?? [];
  const due = queue?.due ?? [];
  const stillValid = async (d: Decision) => {
    const r = await call('confirmStillValid', { id: d.id });
    setMsg(r.ok ? undefined : r.error);
    void reload();
  };
  if (!data.length && !reports.length && !due.length) return <Text>Nothing waiting on you. Conflicts with decisions you own will appear here.</Text>;
  const decide = async (o: PathOverride, state: 'confirmed' | 'excluded') => {
    const r = await call('setPathOverride', { decisionId: o.decisionId, issueKey: o.issueKey, state });
    setMsg(r.ok ? undefined : r.error);
    void reload();
  };
  const resolve = async (c: Conflict, resolution: string) => {
    const r = await call('resolveConflict', { conflictId: c.id, resolution, note: resolution === 'grant_exception' ? `Granted from review queue by ${me}` : undefined });
    setMsg(r.ok ? undefined : r.error);
    void reload();
  };
  return (
    <Stack space="space.150">
      {msg ? <Text color="color.text.danger">{msg}</Text> : null}
      {due.map((d) => (
        <SectionMessage key={`due-${d.id}`} appearance="information" title={`Is "${d.title}" still right?`}>
          <Stack space="space.075">
            <Text>
              Its review date was {d.reviewBy?.slice(0, 10)}.{d.revisitIf ? ` You said to revisit it if ${d.revisitIf}.` : ''} It stays enforced while you decide.
            </Text>
            <Inline space="space.100">
              <Button appearance="primary" onClick={() => stillValid(d)}>Still right: review again in 6 months</Button>
              <Button appearance="subtle" onClick={() => setSuperseding(d)}>Supersede…</Button>
            </Inline>
          </Stack>
        </SectionMessage>
      ))}
      {reports.map((o) => (
        <SectionMessage key={`${o.decisionId}-${o.issueKey}`} appearance="information" title={`${o.issueKey}: "not relevant" report`}>
          <Stack space="space.075">
            <Text>{o.note}</Text>
            <Inline space="space.100" alignBlock="center">
              <Text size="small">From</Text>
              <User accountId={o.byAccountId} />
            </Inline>
            <Inline space="space.100">
              <Button onClick={() => decide(o, 'excluded')}>Agree: doesn't apply</Button>
              <Button appearance="subtle" onClick={() => decide(o, 'confirmed')}>It does apply</Button>
            </Inline>
          </Stack>
        </SectionMessage>
      ))}
      {data.map((c) => (
        <SectionMessage key={c.id} appearance="warning" title={c.issueKey ? `${c.issueKey}` : `Agent proposal in ${c.projectKey}`}>
          <Stack space="space.075">
            <Text>{c.message}</Text>
            <Inline space="space.100" alignBlock="center" shouldWrap>
              <Text size="small">From {c.actorName ?? c.actorType.replace('_', ' ')}</Text>
              {c.actorAccountId ? <User accountId={c.actorAccountId} /> : null}
              <Text size="small">{new Date(c.createdAt).toLocaleString()}</Text>
            </Inline>
            {c.requestNote ? <Text size="small">Request: {c.requestNote}</Text> : null}
            <Inline space="space.100">
              <Button appearance="primary" onClick={() => resolve(c, 'uphold')}>Uphold</Button>
              {c.issueKey ? <Button onClick={() => resolve(c, 'grant_exception')}>Grant exception</Button> : null}
              <Button appearance="subtle" onClick={() => startSupersede(c.decisionId)}>
                Supersede decision…
              </Button>
            </Inline>
          </Stack>
        </SectionMessage>
      ))}
    </Stack>
  );
}

function Register({ me }: { me: string }) {
  const { loading, data, error, reload } = useResolver<Decision[]>('listDecisions');
  const [mode, setMode] = useState<'list' | 'new'>('list');
  const [open, setOpen] = useState<string>();
  if (mode === 'new') {
    return <DecisionForm title="Record a decision" me={me} defaultOwner={me} onDone={() => { setMode('list'); void reload(); }} onCancel={() => setMode('list')} />;
  }
  if (loading && !data) return <Loading what="decisions" />;
  if (error) return <ErrorBox error={error} />;
  const rows = (data ?? []).map((d) => ({
    key: d.id,
    cells: [
      { key: 'title', content: <Button appearance="subtle" onClick={() => setOpen(open === d.id ? undefined : d.id)}>{d.title}</Button> },
      { key: 'status', content: <StatusLozenge status={d.status} /> },
      { key: 'enf', content: <Lozenge appearance={d.enforcement === 'block' ? 'removed' : 'moved'}>{d.enforcement}</Lozenge> },
      { key: 'owner', content: <User accountId={d.ownerAccountId} /> },
      { key: 'scope', content: <Text>{d.scope.projectKeys.join(', ') || 'All projects'}</Text> },
      { key: 'updated', content: <Text>{d.updatedAt.slice(0, 10)}</Text> },
    ],
  }));
  const selected = data?.find((d) => d.id === open);
  return (
    <Stack space="space.150">
      <Inline spread="space-between" alignBlock="center">
        <Text>Every decision your teams have recorded, with who owns it.</Text>
        <Button appearance="primary" onClick={() => setMode('new')}>Record a decision</Button>
      </Inline>
      {selected ? (
        <Stack space="space.100">
          <DecisionSummary d={selected} />
          {selected.status === 'accepted' && selected.trialUntil && Date.parse(selected.trialUntil) > Date.now() ? (
            <TrialPanel key={`t-${selected.id}`} decisionId={selected.id} isOwner={selected.ownerAccountId === me} onEnforced={reload} />
          ) : null}
          {selected.status === 'accepted' ? <AffectedWork key={selected.id} decisionId={selected.id} /> : null}
        </Stack>
      ) : null}
      <DynamicTable
        head={{ cells: ['Decision', 'Status', 'When broken', 'Owner', 'Scope', 'Updated'].map((c) => ({ key: c, content: c })) }}
        rows={rows}
        rowsPerPage={20}
        emptyView={<Text>No decisions yet. Record one here or with the Decision record macro in Confluence. Admins can load demo data from the Setup tab.</Text>}
      />
    </Stack>
  );
}

function Activity() {
  const h = useResolver<{ summary: HealthSummary; dueForReview: Decision[]; ownerless: Decision[] }>('health');
  const [newOwner, setNewOwner] = useState<Record<string, string>>({});
  const [ownerMsg, setOwnerMsg] = useState<string>();
  const reassign = async (d: Decision) => {
    const r = await call('reassignOwner', { id: d.id, ownerAccountId: newOwner[d.id] });
    setOwnerMsg(r.ok ? `"${d.title}" has a new owner.` : r.error);
    void h.reload();
  };
  const receipts = useResolver<Receipt[]>('recentReceipts');
  const [audit, setAudit] = useState<string>();
  if (h.loading && !h.data) return <Loading what="activity" />;
  if (h.error) return <ErrorBox error={h.error} />;
  const s = h.data!.summary;
  const verify = async () => {
    setAudit('Verifying…');
    const r = await call<{ checked: number; brokenAt: number | null }>('verifyAudit');
    setAudit(!r.ok ? r.error : r.data.brokenAt === null ? `Audit trail intact: ${r.data.checked} receipts verified.` : `Audit trail broken at receipt #${r.data.brokenAt}.`);
  };
  return (
    <Stack space="space.200">
      <Inline space="space.150" shouldWrap>
        <Stat label="Accepted decisions" value={s.accepted} />
        <Stat label="Awaiting acceptance" value={s.proposed} />
        <Stat label="Open conflicts" value={s.openConflicts} />
        <Stat label="Blocked (recent checks)" value={s.recentBlocked} />
        <Stat label="Agent checks (recent)" value={(s.byActor.rovo_agent ?? 0) + (s.byActor.mcp_client ?? 0)} />
        <Stat label="Due for review" value={s.dueForReview} />
      </Inline>
      <Inline space="space.100" alignBlock="center">
        <Button onClick={verify}>Verify audit trail</Button>
        {audit ? <Text>{audit}</Text> : null}
      </Inline>
      {h.data!.ownerless.length ? (
        <SectionMessage appearance="warning" title="Decisions whose owner has left">
          <Stack space="space.100">
            <Text>Nobody can approve exceptions or review these. They stay enforced. A Jira administrator can hand them to someone else.</Text>
            {ownerMsg ? <Text>{ownerMsg}</Text> : null}
            {h.data!.ownerless.map((d) => (
              <Inline key={d.id} space="space.100" alignBlock="end" shouldWrap>
                <Text weight="bold">{d.title}</Text>
                <UserPicker label="New owner" name={`owner-${d.id}`} onChange={(u) => u?.id && setNewOwner((m) => ({ ...m, [d.id]: u.id }))} />
                <Button isDisabled={!newOwner[d.id]} onClick={() => reassign(d)}>Reassign</Button>
              </Inline>
            ))}
          </Stack>
        </SectionMessage>
      ) : null}
      {h.data!.dueForReview.length ? (
        <SectionMessage appearance="information" title="Decisions due for review">
          <Text>{h.data!.dueForReview.map((d) => d.title).join(', ')}</Text>
        </SectionMessage>
      ) : null}
      <Heading size="xsmall">Recent checks</Heading>
      <DynamicTable
        head={{ cells: ['#', 'Verdict', 'Actor', 'Action', 'Work', 'When'].map((c) => ({ key: c, content: c })) }}
        rows={(receipts.data ?? []).map((r) => ({
          key: r.id,
          cells: [
            { key: 'seq', content: <Text>{String(r.sequence)}</Text> },
            { key: 'v', content: <VerdictLozenge verdict={r.verdict} /> },
            { key: 'a', content: <Text>{r.actorName ?? r.actorType.replace('_', ' ')}</Text> },
            { key: 't', content: <Text>{r.actionType}{r.toStatus ? ` → ${r.toStatus}` : ''}</Text> },
            { key: 'w', content: <Text>{r.issueKey ?? r.projectKey}</Text> },
            { key: 'c', content: <Text>{new Date(r.createdAt).toLocaleString()}</Text> },
          ],
        }))}
        emptyView={<Text>No checks recorded yet.</Text>}
      />
      <Evidence />
    </Stack>
  );
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Change-control evidence for auditors, for a chosen period. */
function Evidence() {
  const today = new Date();
  const [from, setFrom] = useState(isoDay(new Date(today.getTime() - 90 * 86_400_000)));
  const [to, setTo] = useState(isoDay(today));
  const [projectKey, setProjectKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<EvidenceReport>();
  const [err, setErr] = useState<string>();
  const [showCsv, setShowCsv] = useState(false);
  const run = async () => {
    setBusy(true);
    setErr(undefined);
    const r = await call<EvidenceReport>('evidenceReport', { from, to, projectKey });
    setBusy(false);
    if (r.ok) setReport(r.data);
    else setErr(r.error);
  };
  return (
    <Stack space="space.150">
      <Heading size="xsmall">Audit evidence</Heading>
      <Text>Every check, verdict and approval for a period, with who acted and whether the record is intact. For SOC 2, ISO 27001 and DORA change-control reviews. Jira administrators only.</Text>
      <Inline space="space.150" alignBlock="end" shouldWrap>
        <Stack space="space.050">
          <Label labelFor="dg-ev-from">From</Label>
          <DatePicker id="dg-ev-from" value={from} onChange={(v: string) => setFrom(v)} />
        </Stack>
        <Stack space="space.050">
          <Label labelFor="dg-ev-to">To</Label>
          <DatePicker id="dg-ev-to" value={to} onChange={(v: string) => setTo(v)} />
        </Stack>
        <Stack space="space.050">
          <Label labelFor="dg-ev-project">Project (optional)</Label>
          <Textfield id="dg-ev-project" placeholder="PAY" value={projectKey} onChange={(e) => setProjectKey(e.target.value)} />
        </Stack>
        <Button appearance="primary" isDisabled={busy || !from || !to} onClick={run}>
          {busy ? 'Building…' : 'Build evidence'}
        </Button>
      </Inline>
      {err ? <ErrorBox error={err} /> : null}
      {report ? (
        <Stack space="space.100">
          <SectionMessage appearance={report.chain.intact ? 'success' : 'error'} title={report.chain.intact ? 'Record intact' : 'Record broken'}>
            <Text>
              {report.chain.intact
                ? `All ${report.chain.checked} receipts verified: nothing has been changed or removed.`
                : `The receipt chain breaks at #${report.chain.brokenAt}. Records from that point may have been altered.`}
            </Text>
          </SectionMessage>
          <Inline space="space.150" shouldWrap>
            <Stat label="Checks" value={report.totals.checks} />
            <Stat label="Blocked" value={report.totals.blocked} />
            <Stat label="Warned" value={report.totals.warned} />
            <Stat label="By agents or automation" value={report.totals.byAgents} />
            <Stat label="Exceptions approved" value={report.totals.approvals} />
            <Stat label="Self-approved" value={report.totals.selfApproved} />
          </Inline>
          {report.totals.selfApproved ? (
            <SectionMessage appearance="warning">
              <Text>{report.totals.selfApproved} exception(s) were approved by the person who raised them. Turn on independent approval in Setup to prevent this.</Text>
            </SectionMessage>
          ) : null}
          {report.truncated ? <Text size="small">Showing the first 5,000 checks. Choose a shorter period for the rest.</Text> : null}
          <DynamicTable
            caption="Approvals"
            head={{ cells: ['Work', 'Decision', 'Outcome', 'Raised by', 'Resolved by', 'When'].map((c) => ({ key: c, content: c })) }}
            rows={report.approvals.map((a) => ({
              key: a.conflictId,
              cells: [
                { key: 'w', content: <Text>{a.issueKey}</Text> },
                { key: 'd', content: <Text>{a.decision}</Text> },
                { key: 'o', content: <Lozenge appearance={a.selfApproved && a.outcome === 'exception granted' ? 'moved' : 'default'}>{a.selfApproved && a.outcome === 'exception granted' ? 'self-approved' : a.outcome}</Lozenge> },
                { key: 'r', content: a.raisedByType === 'human' && a.raisedBy ? <User accountId={a.raisedBy} /> : <Text>{a.raisedBy || a.raisedByType}</Text> },
                { key: 'b', content: a.resolvedBy ? <User accountId={a.resolvedBy} /> : <Text>-</Text> },
                { key: 't', content: <Text>{new Date(a.resolvedAt).toLocaleString()}</Text> },
              ],
            }))}
            emptyView={<Text>No approvals in this period.</Text>}
          />
          <Button onClick={() => setShowCsv((v) => !v)}>{showCsv ? 'Hide CSV' : 'Show CSV to copy'}</Button>
          {showCsv ? <CodeBlock language="text" text={report.csv} shouldWrapLongLines={false} /> : null}
        </Stack>
      ) : null}
    </Stack>
  );
}

interface SetupData {
  settings: { teamworkGraph: boolean; strongIssueLinks: string[]; graphRefreshedAt: string | null; independentApproval: boolean };
  isAdmin: boolean;
  demoLoaded: boolean;
}

function Setup() {
  const { loading, data, error, reload } = useResolver<SetupData>('setup');
  const [projectKey, setProjectKey] = useState('');
  const [links, setLinks] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  if (loading && !data) return <Loading what="setup" />;
  if (error || !data) return <ErrorBox error={error ?? 'Could not load setup.'} />;

  const toggleTwg = async () => {
    setBusy(true);
    const r = await call('updateSettings', { patch: { teamworkGraph: !data.settings.teamworkGraph } });
    setBusy(false);
    setMsg(r.ok ? undefined : { ok: false, text: r.error });
    void reload();
  };
  const toggleIndependent = async () => {
    setBusy(true);
    const r = await call('updateSettings', { patch: { independentApproval: !data.settings.independentApproval } });
    setBusy(false);
    setMsg(r.ok ? undefined : { ok: false, text: r.error });
    void reload();
  };
  const saveLinks = async () => {
    setBusy(true);
    const names = (links ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const r = await call('updateSettings', { patch: { strongIssueLinks: names } });
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: 'Link settings saved.' } : { ok: false, text: r.error });
    void reload();
  };
  const seed = async () => {
    setBusy(true);
    setMsg(undefined);
    const r = await call<{ issues: { key: string; verdict: string }[] }>('seedDemo', { projectKey });
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: `Demo loaded: 3 decisions and issues ${r.data.issues.map((i) => `${i.key} (${i.verdict})`).join(', ')}. Open one to see the Decisions panel.` } : { ok: false, text: r.error });
    void reload();
  };

  return (
    <Stack space="space.300">
      {!data.isAdmin ? (
        <SectionMessage appearance="information">
          <Text>Only Jira administrators can change these settings.</Text>
        </SectionMessage>
      ) : null}
      {msg ? (
        <SectionMessage appearance={msg.ok ? 'success' : 'error'}>
          <Text>{msg.text}</Text>
        </SectionMessage>
      ) : null}

      <Stack space="space.100">
        <Heading size="small">Demo data</Heading>
        <Text>Creates three decisions you own and three issues in a project you choose: one is blocked, one is clear, one gets a warning.</Text>
        {data.demoLoaded ? (
          <Text>Demo data is already loaded on this site.</Text>
        ) : (
          <Inline space="space.100" alignBlock="end">
            <Stack space="space.050">
              <Label labelFor="dg-demo-project">Project key</Label>
              <Textfield id="dg-demo-project" placeholder="PAY" value={projectKey} onChange={(e) => setProjectKey(e.target.value)} isDisabled={!data.isAdmin} />
            </Stack>
            <Button appearance="primary" isDisabled={!data.isAdmin || busy || !projectKey.trim()} onClick={seed}>
              Load demo data
            </Button>
          </Inline>
        )}
      </Stack>

      <Stack space="space.100">
        <Heading size="small">Linked work</Heading>
        <Text>
          Decisions recorded on a Confluence page also apply to issues linked to that page, and to issues under an epic or parent linked to it (up to two steps). Matches found this way only warn until the owner confirms them.
        </Text>
        <Text size="small">
          Links last fully refreshed: {data.settings.graphRefreshedAt ? new Date(data.settings.graphRefreshedAt).toLocaleString() : 'not yet (runs shortly after install, then daily)'}
        </Text>
        <Stack space="space.050">
          <Label labelFor="dg-strong-links">Issue link types that also carry decisions (comma separated)</Label>
          <Inline space="space.100" alignBlock="end">
            <Textfield
              id="dg-strong-links"
              placeholder="Blocks, Cloners"
              value={links ?? data.settings.strongIssueLinks.join(', ')}
              onChange={(e) => setLinks(e.target.value)}
              isDisabled={!data.isAdmin}
            />
            <Button isDisabled={!data.isAdmin || busy || links === undefined} onClick={saveLinks}>
              Save
            </Button>
          </Inline>
          <HelperMessage>Use Jira's link type names, e.g. Blocks. Leave empty to ignore issue links.</HelperMessage>
        </Stack>
      </Stack>

      <Stack space="space.100">
        <Heading size="small">Independent approval</Heading>
        <Text>Nobody can approve an exception for a conflict they raised. When the decision owner raised it, a Jira administrator approves instead. Auditors look for this separation of duties.</Text>
        <Inline space="space.100" alignBlock="center">
          <Toggle id="dg-independent" isChecked={data.settings.independentApproval} isDisabled={!data.isAdmin || busy} onChange={toggleIndependent} />
          <Text>{data.settings.independentApproval ? 'On' : 'Off'}</Text>
        </Inline>
      </Stack>

      <Stack space="space.100">
        <Heading size="small">Teamwork Graph</Heading>
        <Text>Shows each decision owner's teams and suggests owners from Confluence page ownership. The Teamwork Graph API is in Early Access; Atlassian asks that apps calling it only be installed in test organisations.</Text>
        <Inline space="space.100" alignBlock="center">
          <Toggle id="dg-twg" isChecked={data.settings.teamworkGraph} isDisabled={!data.isAdmin || busy} onChange={toggleTwg} />
          <Text>{data.settings.teamworkGraph ? 'On' : 'Off'}</Text>
        </Inline>
      </Stack>
    </Stack>
  );
}

function App() {
  const who = useResolver<{ accountId: string }>('whoami');
  if (who.loading) return <Loading what="DecisionGraph" />;
  if (who.error || !who.data) return <ErrorBox error={who.error ?? 'Not signed in.'} />;
  const me = who.data.accountId;
  return (
    <Stack space="space.200">
      <Heading size="large">DecisionGraph</Heading>
      <Text>Your team's decisions, enforced: no person or agent quietly contradicts what's already been decided.</Text>
      <Tabs id="dg-tabs">
        <TabList>
          <Tab>My review queue</Tab>
          <Tab>Decisions</Tab>
          <Tab>Activity</Tab>
          <Tab>Setup</Tab>
        </TabList>
        <TabPanel>
          <Box xcss={xcss({ paddingBlock: 'space.200', width: '100%' })}>
            <ReviewQueue me={me} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box xcss={xcss({ paddingBlock: 'space.200', width: '100%' })}>
            <Register me={me} />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box xcss={xcss({ paddingBlock: 'space.200', width: '100%' })}>
            <Activity />
          </Box>
        </TabPanel>
        <TabPanel>
          <Box xcss={xcss({ paddingBlock: 'space.200', width: '100%' })}>
            <Setup />
          </Box>
        </TabPanel>
      </Tabs>
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
