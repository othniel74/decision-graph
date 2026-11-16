import React, { useState } from 'react';
import { Button, DynamicTable, Link, Lozenge, SectionMessage, Stack, Text } from '@forge/react';
import type { ImpactReport } from '../domain/impact';
import { call } from './shared';

export type ImpactResult = ImpactReport & { jql: string };

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
          {waived ? `. ${waived} more covered by an owner exception` : ''}. Status-move rules are checked when work moves, not here.
        </Text>
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
              { key: 'w', content: <Text size="small">{a.violations.map((v) => v.message).join(' ')}</Text> },
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
