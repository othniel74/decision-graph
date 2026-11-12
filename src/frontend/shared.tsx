import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';
import { Box, Inline, Link, Lozenge, SectionMessage, Spinner, Stack, Text, User, xcss } from '@forge/react';
import type { Decision, Verdict } from '../domain/types';
import { describeDecisionRules } from '../domain/describe';

export type Result<T> = { ok: true; data: T } | { ok: false; error: string; code: string };

export async function call<T>(fn: string, payload: Record<string, unknown> = {}): Promise<Result<T>> {
  try {
    const r = await invoke<Result<T>>(fn, payload);
    // invoke only wraps the body when request metadata is asked for; we never ask, but stay safe.
    return r && typeof r === 'object' && 'ok' in r ? r : (r as { body: Result<T> }).body;
  } catch {
    return { ok: false, error: 'Could not reach DecisionGraph. Refresh and try again.', code: 'NETWORK' };
  }
}

/** Load data from a resolver with loading, error and reload state. */
export function useResolver<T>(fn: string, payload: Record<string, unknown> = {}) {
  const [state, setState] = useState<{ loading: boolean; data?: T; error?: string }>({ loading: true });
  const key = JSON.stringify(payload);
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    const r = await call<T>(fn, JSON.parse(key));
    setState(r.ok ? { loading: false, data: r.data } : { loading: false, error: r.error });
  }, [fn, key]);
  useEffect(() => {
    void load();
  }, [load]);
  return { ...state, reload: load };
}

export function Loading({ what }: { what: string }) {
  return (
    <Inline space="space.100" alignBlock="center">
      <Spinner size="small" label={`Loading ${what}`} />
      <Text>Loading {what}…</Text>
    </Inline>
  );
}

export function ErrorBox({ error }: { error: string }) {
  return (
    <SectionMessage appearance="error" title="Something went wrong">
      <Text>{error}</Text>
    </SectionMessage>
  );
}

const VERDICT: Record<Verdict, { appearance: 'success' | 'moved' | 'removed'; label: string }> = {
  allow: { appearance: 'success', label: 'Clear' },
  warn: { appearance: 'moved', label: 'Conflicts' },
  block: { appearance: 'removed', label: 'Blocked' },
};

export function VerdictLozenge({ verdict }: { verdict: Verdict }) {
  const v = VERDICT[verdict];
  return (
    <Lozenge appearance={v.appearance} isBold>
      {v.label}
    </Lozenge>
  );
}

const STATUS_APPEARANCE: Record<Decision['status'], 'success' | 'inprogress' | 'default' | 'removed' | 'moved'> = {
  accepted: 'success',
  proposed: 'inprogress',
  superseded: 'default',
  deprecated: 'default',
  rejected: 'removed',
};

export function StatusLozenge({ status }: { status: Decision['status'] }) {
  return <Lozenge appearance={STATUS_APPEARANCE[status]}>{status}</Lozenge>;
}

const card = xcss({
  padding: 'space.150',
  borderColor: 'color.border',
  borderWidth: 'border.width',
  borderStyle: 'solid',
  borderRadius: 'radius.medium',
});

export function DecisionSummary({ d }: { d: Decision }) {
  return (
    <Box xcss={card}>
      <Stack space="space.075">
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <Text weight="bold">{d.title}</Text>
          <StatusLozenge status={d.status} />
          <Lozenge appearance={d.enforcement === 'block' ? 'removed' : 'moved'}>{d.enforcement}</Lozenge>
        </Inline>
        <Text>{d.statement}</Text>
        {d.rationale ? <Text size="small">Why: {d.rationale}</Text> : null}
        {describeDecisionRules(d).map((line, i) => (
          <Text key={i} size="small" color="color.text.subtle">
            • {line}
          </Text>
        ))}
        <Inline space="space.100" alignBlock="center" shouldWrap>
          <Text size="small">Owner:</Text>
          <User accountId={d.ownerAccountId} />
          {d.sourceUrl ? <Link href={d.sourceUrl} openNewTab>Source</Link> : null}
        </Inline>
      </Stack>
    </Box>
  );
}

export const commaList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);
