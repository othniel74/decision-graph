import React, { useState } from 'react';
import { Button, DynamicTable, Inline, Link, Lozenge, SectionMessage, Stack, Text } from '@forge/react';
import type { ImpactResult } from '../services/impact';
import { call } from './shared';

export type { ImpactResult };

export function ImpactList({ report }: { report: ImpactResult }) {
  const open = report.affected.filter((a) => !a.waived);
  const waived = report.affected.length - open.length;
  const head = `${open.length} open issue${open.length === 1 ? '' : 's'} contradict${open.length === 1 ? 's' : ''} this decision`;
  return (
    <Stack space="space.100">
      <SectionMessage appearance={open.length ? 'warning' : 'success'} title={open.length ? head : 'No open work contradicts this decision'}>
        <Text>
          Checked {report.scanned} open issue{report.scanned === 1 ? '' : 's'} in scope
          {report.truncated ? ' (stopped at the limit; narrow the scope to see the rest)' : ''}
          {waived ? `. ${waived} more covered by an owner exception` : ''}
          {report.connectedCount ? `, including ${report.connectedCount} linked to the decision's page` : ''}. Status-move rules are checked when work moves, not here.
        </Text>
        {report.graphStale ? <Text size="small">Linked work was skipped because the link data is being refreshed.</Text> : null}
      </SectionMessage>
      {open.length ? (
        <DynamicTable
          head={{ cells: ['Issue', 'Summary', 'Status', 'Why'].map((c) => ({ key: c, content: c })) }}
          rows={open.map((a) => ({
            key: a.key,
            cells: [
              { key: 'k', content: <Link href={`/browse/${a.key}`} openNewTab>{a.key}</Link> },
              { key: 's', content: <Text>{a.summary}</Text> },
              { key: 'st', content: a.status ? <Lozenge>{a.status}</Lozenge> : <Text>—</Text> },
              {
                key: 'w',
                content: (
                  <Text size="small">
                    {a.violations.map((v) => v.message).join(' ')}
                    {a.violations[0]?.path ? ` Via ${a.violations[0].path.join(' → ')}.` : ''}
                  </Text>
                ),
              },
            ],
          }))}
          rowsPerPage={10}
        />
      ) : null}
    </Stack>
  );
}

/** Button that loads and shows open work affected by a saved decision. */
export function AffectedWork({ decisionId }: { decisionId: string }) {
  const [state, setState] = useState<{ busy: boolean; report?: ImpactResult; error?: string }>({ busy: false });
  if (state.report) return <ImpactList report={state.report} />;
  return (
    <Stack space="space.050">
      <Button
        appearance="subtle"
        isDisabled={state.busy}
        onClick={async () => {
          setState({ busy: true });
          const r = await call<ImpactResult>('decisionImpact', { id: decisionId });
          setState(r.ok ? { busy: false, report: r.data } : { busy: false, error: r.error });
        }}
      >
        {state.busy ? 'Checking open work…' : 'Show affected work'}
      </Button>
      {state.error ? <Text color="color.text.danger">{state.error}</Text> : null}
    </Stack>
  );
}

interface ShadowConflict {
  id: string;
  issueKey?: string;
  projectKey: string;
  message: string;
  actorType: string;
  actorName?: string;
  createdAt: string;
}

/** For a decision in its trial run: what it would have flagged so far, and (for the owner) Enforce now. */
export function TrialPanel({ decisionId, isOwner, onEnforced }: { decisionId: string; isOwner: boolean; onEnforced: () => void }) {
  const [hits, setHits] = useState<ShadowConflict[]>();
  const [error, setError] = useState<string>();
  const load = async () => {
    const r = await call<ShadowConflict[]>('trialHits', { id: decisionId });
    if (r.ok) setHits(r.data);
    else setError(r.error);
  };
  const enforce = async () => {
    const r = await call('enforceNow', { id: decisionId });
    if (r.ok) onEnforced();
    else setError(r.error);
  };
  return (
    <Stack space="space.075">
      <Inline space="space.100">
        {hits ? null : (
          <Button appearance="subtle" onClick={load}>
            What would it have flagged?
          </Button>
        )}
        {isOwner ? (
          <Button appearance="primary" onClick={enforce}>
            End trial and enforce now
          </Button>
        ) : null}
      </Inline>
      {error ? <Text color="color.text.danger">{error}</Text> : null}
      {hits && hits.length === 0 ? <Text size="small">Nothing yet. That's a good sign the rules are precise.</Text> : null}
      {hits && hits.length ? (
        <DynamicTable
          head={{ cells: ['Work', 'Would have flagged', 'From', 'When'].map((c) => ({ key: c, content: c })) }}
          rows={hits.map((h) => ({
            key: h.id,
            cells: [
              { key: 'k', content: h.issueKey ? <Link href={`/browse/${h.issueKey}`} openNewTab>{h.issueKey}</Link> : <Text>Agent plan in {h.projectKey}</Text> },
              { key: 'm', content: <Text size="small">{h.message}</Text> },
              { key: 'a', content: <Text size="small">{h.actorName ?? h.actorType.replace('_', ' ')}</Text> },
              { key: 'w', content: <Text size="small">{h.createdAt.slice(0, 10)}</Text> },
            ],
          }))}
          rowsPerPage={10}
        />
      ) : null}
    </Stack>
  );
}
