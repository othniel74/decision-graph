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
  User,
  xcss,
} from '@forge/react';
import type { Decision } from '../domain/types';
import type { Receipt } from '../domain/receipt';
import type { Conflict } from '../storage/store';
import type { HealthSummary } from '../services/audit';
import { DecisionForm } from './decision-form';
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
  const { loading, data, error, reload } = useResolver<Conflict[]>('reviewQueue');
  const [msg, setMsg] = useState<string>();
  if (loading && !data) return <Loading what="your review queue" />;
  if (error) return <ErrorBox error={error} />;
  if (!data?.length) return <Text>Nothing waiting on you. Conflicts with decisions you own will appear here.</Text>;
  const resolve = async (c: Conflict, resolution: string) => {
    const r = await call('resolveConflict', { conflictId: c.id, resolution, note: resolution === 'grant_exception' ? `Granted from review queue by ${me}` : undefined });
    setMsg(r.ok ? undefined : r.error);
    void reload();
  };
  return (
    <Stack space="space.150">
      {msg ? <Text color="color.text.danger">{msg}</Text> : null}
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
      {selected ? <DecisionSummary d={selected} /> : null}
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
  const h = useResolver<{ summary: HealthSummary; dueForReview: Decision[] }>('health');
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
    </Stack>
  );
}

interface SetupData {
  settings: { teamworkGraph: boolean };
  isAdmin: boolean;
  demoLoaded: boolean;
}

function Setup() {
  const { loading, data, error, reload } = useResolver<SetupData>('setup');
  const [projectKey, setProjectKey] = useState('');
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
