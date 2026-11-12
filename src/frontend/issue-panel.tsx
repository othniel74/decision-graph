import React, { useState } from 'react';
import ForgeReconciler, {
  Button,
  ButtonGroup,
  Heading,
  Inline,
  Link,
  SectionMessage,
  Stack,
  Text,
  TextArea,
  User,
  Lozenge,
} from '@forge/react';
import type { CheckResult, Decision, DecisionException } from '../domain/types';
import type { Conflict } from '../storage/store';
import type { TeamRef } from '../adapters/teamwork-graph';
import { call, DecisionSummary, ErrorBox, Loading, useResolver, VerdictLozenge } from './shared';

interface PanelData {
  me: string;
  issueKey: string;
  result: CheckResult;
  applicable: Decision[];
  conflicts: Conflict[];
  exceptions: DecisionException[];
  ownerTeams: Record<string, TeamRef[]>;
}

function ConflictCard({ c, d, me, onChange }: { c: Conflict; d?: Decision; me: string; onChange: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const isOwner = d?.ownerAccountId === me;

  async function act(fn: string, payload: Record<string, unknown>) {
    setBusy(true);
    setError(undefined);
    const r = await call(fn, payload);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setNote('');
    onChange();
  }

  return (
    <SectionMessage appearance={c.status === 'open' ? 'warning' : 'information'} title={`Conflict with "${d?.title ?? c.decisionId}"`}>
      <Stack space="space.100">
        <Text>{c.message}</Text>
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <Lozenge>{c.status}</Lozenge>
          <Text size="small">Raised by {c.actorName ?? c.actorType.replace('_', ' ')}</Text>
          {c.actorAccountId ? <User accountId={c.actorAccountId} /> : null}
        </Inline>
        {c.requestNote ? <Text size="small">Exception request: {c.requestNote}</Text> : null}
        {c.resolutionNote ? <Text size="small">Owner note: {c.resolutionNote}</Text> : null}
        {error ? <Text color="color.text.danger">{error}</Text> : null}
        {c.status === 'open' ? (
          <Stack space="space.100">
            <TextArea
              placeholder={isOwner ? 'Note to the team (required to grant an exception)' : 'Why is an exception needed?'}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <ButtonGroup>
              {isOwner ? (
                <>
                  <Button appearance="primary" isDisabled={busy} onClick={() => act('resolveConflict', { conflictId: c.id, resolution: 'uphold', note })}>
                    Uphold decision
                  </Button>
                  <Button isDisabled={busy || !note.trim()} onClick={() => act('resolveConflict', { conflictId: c.id, resolution: 'grant_exception', note })}>
                    Grant exception for this issue
                  </Button>
                </>
              ) : (
                <Button appearance="primary" isDisabled={busy || !note.trim()} onClick={() => act('requestException', { conflictId: c.id, note })}>
                  Ask owner for an exception
                </Button>
              )}
              {c.actorAccountId === me || isOwner ? (
                <Button appearance="subtle" isDisabled={busy} onClick={() => act('resolveConflict', { conflictId: c.id, resolution: 'withdraw', note })}>
                  I changed the plan
                </Button>
              ) : null}
            </ButtonGroup>
          </Stack>
        ) : null}
      </Stack>
    </SectionMessage>
  );
}

function App() {
  const { loading, data, error, reload } = useResolver<PanelData>('issuePanel');
  if (loading && !data) return <Loading what="decisions" />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const byId = new Map(data.applicable.map((d) => [d.id, d]));
  const open = data.conflicts.filter((c) => c.status === 'open');
  const { result } = data;

  return (
    <Stack space="space.200">
      <Inline space="space.100" alignBlock="center" spread="space-between">
        <Inline space="space.100" alignBlock="center">
          <VerdictLozenge verdict={result.verdict} />
          <Text>
            {data.applicable.length} decision{data.applicable.length === 1 ? '' : 's'} apply to this work
          </Text>
        </Inline>
        <Button appearance="subtle" onClick={reload}>
          Recheck
        </Button>
      </Inline>

      {result.violations.map((v) => (
        <SectionMessage key={`${v.decisionId}-${v.constraintId}`} appearance={v.enforcement === 'block' ? 'error' : 'warning'} title={v.decisionTitle}>
          <Stack space="space.075">
            <Text>{v.message}</Text>
            <Inline space="space.100" alignBlock="center" shouldWrap>
              <Text size="small">Owner:</Text>
              <User accountId={v.ownerAccountId} />
              {(data.ownerTeams[v.ownerAccountId] ?? []).slice(0, 2).map((t) => (
                <Lozenge key={t.id}>{t.name}</Lozenge>
              ))}
              {v.sourceUrl ? (
                <Link href={v.sourceUrl} openNewTab>
                  Read the decision
                </Link>
              ) : null}
            </Inline>
          </Stack>
        </SectionMessage>
      ))}

      {result.waived.length ? (
        <SectionMessage appearance="information" title="Covered by an exception">
          <Text>
            {result.waived.length} conflict{result.waived.length === 1 ? ' is' : 's are'} allowed here by the decision owner.
          </Text>
        </SectionMessage>
      ) : null}

      {open.length ? <Heading size="xsmall">Waiting on the owner</Heading> : null}
      {open.map((c) => (
        <ConflictCard key={c.id} c={c} d={byId.get(c.decisionId)} me={data.me} onChange={reload} />
      ))}

      {data.applicable.length ? <Heading size="xsmall">Decisions that apply</Heading> : null}
      {data.applicable.map((d) => (
        <DecisionSummary key={d.id} d={d} />
      ))}
      {data.applicable.length === 0 ? (
        <Text>
          No recorded decisions cover this work yet. Record one with the Decision record macro in Confluence, or in Apps → DecisionGraph.
        </Text>
      ) : null}
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
