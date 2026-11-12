import React, { useState } from 'react';
import ForgeReconciler, { Button, ButtonGroup, Inline, Stack, Text, useProductContext } from '@forge/react';
import type { Decision } from '../domain/types';
import { DecisionForm } from './decision-form';
import { call, DecisionSummary, ErrorBox, Loading, useResolver } from './shared';

interface PageData {
  me: string;
  pageId: string;
  decisions: Decision[];
  suggestedOwner: string;
}

function OwnerActions({ d, me, onChange, onSupersede }: { d: Decision; me: string; onChange: () => void; onSupersede: () => void }) {
  const [error, setError] = useState<string>();
  if (d.ownerAccountId !== me) return null;
  const change = async (to: string) => {
    const r = await call('changeStatus', { id: d.id, to });
    if (!r.ok) setError(r.error);
    else onChange();
  };
  return (
    <Stack space="space.050">
      <ButtonGroup>
        {d.status === 'proposed' ? (
          <>
            <Button appearance="primary" onClick={() => change('accepted')}>Accept and enforce</Button>
            <Button onClick={() => change('rejected')}>Reject</Button>
          </>
        ) : null}
        {d.status === 'accepted' ? (
          <>
            <Button onClick={onSupersede}>Supersede</Button>
            <Button appearance="subtle" onClick={() => change('deprecated')}>Retire</Button>
          </>
        ) : null}
      </ButtonGroup>
      {error ? <Text color="color.text.danger">{error}</Text> : null}
    </Stack>
  );
}

function App() {
  const context = useProductContext();
  const { loading, data, error, reload } = useResolver<PageData>('pageDecisions');
  const [mode, setMode] = useState<{ kind: 'view' } | { kind: 'new' } | { kind: 'supersede'; d: Decision }>({ kind: 'view' });

  if (loading && !data) return <Loading what="decision record" />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const siteUrl = (context as { siteUrl?: string } | undefined)?.siteUrl;
  const sourceUrl = siteUrl ? `${siteUrl}/wiki/pages/viewpage.action?pageId=${data.pageId}` : undefined;
  const done = () => {
    setMode({ kind: 'view' });
    void reload();
  };

  if (mode.kind !== 'view') {
    return (
      <DecisionForm
        title={mode.kind === 'new' ? 'Record a decision from this page' : `Supersede "${mode.d.title}"`}
        me={data.me}
        defaultOwner={mode.kind === 'supersede' ? mode.d.ownerAccountId : data.suggestedOwner}
        sourcePageId={data.pageId}
        sourceUrl={sourceUrl}
        supersedes={mode.kind === 'supersede' ? mode.d : undefined}
        onDone={done}
        onCancel={() => setMode({ kind: 'view' })}
      />
    );
  }

  const live = data.decisions.filter((d) => d.status === 'accepted' || d.status === 'proposed');
  const past = data.decisions.filter((d) => d.status !== 'accepted' && d.status !== 'proposed');

  return (
    <Stack space="space.150">
      <Inline spread="space-between" alignBlock="center">
        <Text weight="bold">Decision record</Text>
        <Button appearance="primary" onClick={() => setMode({ kind: 'new' })}>Record a decision</Button>
      </Inline>
      {live.length === 0 ? <Text>No decisions recorded on this page yet. Record one so Jira work and agents stay consistent with it.</Text> : null}
      {live.map((d) => (
        <Stack key={d.id} space="space.075">
          <DecisionSummary d={d} />
          <OwnerActions d={d} me={data.me} onChange={reload} onSupersede={() => setMode({ kind: 'supersede', d })} />
        </Stack>
      ))}
      {past.length ? <Text size="small">History: {past.map((d) => `${d.title} (${d.status})`).join(' · ')}</Text> : null}
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
