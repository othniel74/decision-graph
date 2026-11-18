import React, { useState } from 'react';
import {
  Button,
  ButtonGroup,
  Heading,
  Inline,
  Label,
  RequiredAsterisk,
  Select,
  SectionMessage,
  Stack,
  Text,
  TextArea,
  Textfield,
  UserPicker,
  HelperMessage,
  Checkbox,
} from '@forge/react';
import type { ConstraintKind, Decision } from '../domain/types';
import { describeConstraint } from '../domain/describe';
import { call, commaList } from './shared';
import { ImpactList, type ImpactResult } from './impact';

/**
 * Form for recording or superseding a decision with one or more enforceable constraints.
 * Inputs are plain text so the form works on every surface; the backend validates everything.
 */

type Opt = { label: string; value: string };

const KINDS: Opt[] = [
  { label: 'Work must not mention…', value: 'forbid_terms' },
  { label: 'Work must not carry labels…', value: 'forbid_labels' },
  { label: 'Work must not be in components…', value: 'forbid_components' },
  { label: 'Restrict moving to a status (optional freeze window)', value: 'restrict_transition' },
  { label: 'Require a field before a status', value: 'require_field' },
];

const REACH: Opt[] = [
  { label: 'Automatic: linked work, plus the projects and labels below if set', value: 'auto' },
  { label: 'Only work linked to this page', value: 'connected' },
  { label: 'Only the projects and labels below', value: 'scope' },
  { label: 'Both', value: 'both' },
];

const DAYS: Opt[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => ({ label: d, value: String(i) }));

interface ConstraintRow {
  kind: ConstraintKind;
  values: string;
  statuses: string;
  field: string;
  fieldLabel: string;
  days: string[];
  fromHour: string;
  toHour: string;
  timezone: string;
}

const emptyRow = (): ConstraintRow => ({
  kind: 'forbid_terms',
  values: '',
  statuses: '',
  field: '',
  fieldLabel: '',
  days: [],
  fromHour: '',
  toHour: '',
  timezone: 'Europe/London',
});

function toConstraint(r: ConstraintRow): Record<string, unknown> {
  switch (r.kind) {
    case 'forbid_terms':
      return { kind: r.kind, terms: commaList(r.values) };
    case 'forbid_labels':
      return { kind: r.kind, labels: commaList(r.values) };
    case 'forbid_components':
      return { kind: r.kind, components: commaList(r.values) };
    case 'restrict_transition':
      return {
        kind: r.kind,
        toStatuses: commaList(r.statuses),
        window: r.days.length ? { days: r.days.map(Number), fromHour: Number(r.fromHour || 0), toHour: Number(r.toHour || 0), timezone: r.timezone } : undefined,
      };
    case 'require_field':
      return { kind: r.kind, field: r.field, fieldLabel: r.fieldLabel || r.field, whenEnteringStatuses: commaList(r.statuses) };
  }
}

const valuesLabel: Partial<Record<ConstraintKind, string>> = {
  forbid_terms: 'Terms (comma separated), e.g. store card, card number',
  forbid_labels: 'Labels (comma separated)',
  forbid_components: 'Components (comma separated)',
};

export interface DecisionFormProps {
  title: string;
  /** The signed-in user. If they are not the owner, the decision starts as proposed. */
  me: string;
  defaultOwner: string;
  sourcePageId?: string;
  sourceUrl?: string;
  /** When set, the form supersedes this decision instead of creating a new one. */
  supersedes?: Decision;
  onDone: (d: Decision) => void;
  onCancel?: () => void;
}

export function DecisionForm(props: DecisionFormProps) {
  const base = props.supersedes;
  const [title, setTitle] = useState(base?.title ?? '');
  const [statement, setStatement] = useState(base?.statement ?? '');
  const [rationale, setRationale] = useState(base?.rationale ?? '');
  const [owner, setOwner] = useState(base?.ownerAccountId ?? props.defaultOwner);
  const [enforcement, setEnforcement] = useState<'block' | 'warn'>(base?.enforcement ?? 'block');
  const [projects, setProjects] = useState(base?.scope.projectKeys.join(', ') ?? '');
  const [scopeLabels, setScopeLabels] = useState(base?.scope.labels.join(', ') ?? '');
  const [rows, setRows] = useState<ConstraintRow[]>([emptyRow()]);
  const [trial, setTrial] = useState(!base);
  const sourcePage = props.sourcePageId ?? base?.sourcePageId;
  const [reach, setReach] = useState<string>(base?.reach ?? 'auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [impact, setImpact] = useState<ImpactResult>();

  const previewScope = { projectKeys: commaList(projects), issueTypes: [], components: [], labels: commaList(scopeLabels) };
  const previewOpts = { linked: Boolean(sourcePage) && reach !== 'scope', linkedOnly: Boolean(sourcePage) && reach === 'connected' };
  const update = (i: number, patch: Partial<ConstraintRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const buildDraft = () => ({
      title,
      statement,
      rationale,
      ownerAccountId: owner,
      enforcement,
      scope: { projectKeys: commaList(projects), labels: commaList(scopeLabels) },
      constraints: rows.map(toConstraint),
      sourcePageId: sourcePage,
      sourceUrl: props.sourceUrl ?? base?.sourceUrl,
      reach: reach === 'auto' ? undefined : reach,
      trialDays: trial ? 7 : 0,
  });

  async function checkImpact() {
    setBusy(true);
    setError(undefined);
    const r = await call<ImpactResult>('previewImpact', { draft: buildDraft() });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setImpact(r.data);
  }

  async function submit() {
    setBusy(true);
    setError(undefined);
    const draft = buildDraft();
    const r = base
      ? await call<{ replacement: Decision }>('supersede', { id: base.id, draft })
      : await call<Decision>('createDecision', { draft });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    props.onDone('replacement' in r.data ? r.data.replacement : (r.data as Decision));
  }

  return (
    <Stack space="space.150">
      <Heading size="small">{props.title}</Heading>
      {error ? (
        <SectionMessage appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      ) : null}
      <Stack space="space.050">
        <Label labelFor="dg-title">Decision title<RequiredAsterisk /></Label>
        <Textfield id="dg-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Stack>
      <Stack space="space.050">
        <Label labelFor="dg-statement">What was decided<RequiredAsterisk /></Label>
        <TextArea id="dg-statement" value={statement} onChange={(e) => setStatement(e.target.value)} />
      </Stack>
      <Stack space="space.050">
        <Label labelFor="dg-rationale">Why</Label>
        <TextArea id="dg-rationale" value={rationale} onChange={(e) => setRationale(e.target.value)} />
      </Stack>
      <UserPicker label="Decision owner" name="owner" defaultValue={owner} isRequired onChange={(u) => u?.id && setOwner(u.id)} />
      <Inline space="space.200" shouldWrap>
        <Stack space="space.050">
          <Label labelFor="dg-projects">Jira projects (keys)</Label>
          <Textfield id="dg-projects" placeholder="PAY, CHECKOUT" value={projects} onChange={(e) => setProjects(e.target.value)} />
          <HelperMessage>Leave empty to apply everywhere.</HelperMessage>
        </Stack>
        <Stack space="space.050">
          <Label labelFor="dg-scope-labels">Only work with labels</Label>
          <Textfield id="dg-scope-labels" placeholder="pci" value={scopeLabels} onChange={(e) => setScopeLabels(e.target.value)} />
        </Stack>
        <Stack space="space.050">
          <Label labelFor="dg-enf">When broken</Label>
          <Select
            inputId="dg-enf"
            value={{ label: enforcement === 'block' ? 'Block' : 'Warn', value: enforcement }}
            options={[{ label: 'Block', value: 'block' }, { label: 'Warn', value: 'warn' }]}
            onChange={(o: Opt) => setEnforcement(o.value as 'block' | 'warn')}
          />
        </Stack>
      </Inline>

      {sourcePage ? (
        <Stack space="space.050">
          <Label labelFor="dg-reach">Which work does it apply to?</Label>
          <Select
            inputId="dg-reach"
            value={REACH.find((r) => r.value === reach)}
            options={REACH}
            onChange={(o: Opt) => setReach(o.value)}
          />
          <HelperMessage>Linked work = issues linked to this page, and issues under an epic or parent linked to it.</HelperMessage>
        </Stack>
      ) : null}
      <Checkbox
        id="dg-trial"
        label="Start with a 7-day trial run: record what it would flag, without blocking or notifying anyone"
        isChecked={trial}
        onChange={() => setTrial((t) => !t)}
      />

      <Heading size="xsmall">Rules that enforce it</Heading>
      {rows.map((r, i) => (
        <Stack key={i} space="space.100">
          <Select
            inputId={`dg-kind-${i}`}
            value={KINDS.find((k) => k.value === r.kind)}
            options={KINDS}
            onChange={(o: Opt) => update(i, { kind: o.value as ConstraintKind })}
          />
          {valuesLabel[r.kind] ? (
            <Textfield placeholder={valuesLabel[r.kind]} value={r.values} onChange={(e) => update(i, { values: e.target.value })} />
          ) : null}
          {r.kind === 'restrict_transition' || r.kind === 'require_field' ? (
            <Textfield placeholder="Statuses (comma separated), e.g. Done, Deployed" value={r.statuses} onChange={(e) => update(i, { statuses: e.target.value })} />
          ) : null}
          {r.kind === 'require_field' ? (
            <Inline space="space.100">
              <Textfield placeholder="Field id, e.g. customfield_10042" value={r.field} onChange={(e) => update(i, { field: e.target.value })} />
              <Textfield placeholder="Field name shown to people" value={r.fieldLabel} onChange={(e) => update(i, { fieldLabel: e.target.value })} />
            </Inline>
          ) : null}
          {r.kind === 'restrict_transition' ? (
            <Stack space="space.050">
              <Text size="small">Freeze window (optional): restriction applies only during these times.</Text>
              <Select
                isMulti
                placeholder="Days"
                value={DAYS.filter((d) => r.days.includes(d.value))}
                options={DAYS}
                onChange={(os: Opt[]) => update(i, { days: (os ?? []).map((o) => o.value) })}
              />
              <Inline space="space.100">
                <Textfield type="number" placeholder="From hour (0-23)" value={r.fromHour} onChange={(e) => update(i, { fromHour: e.target.value })} />
                <Textfield type="number" placeholder="To hour (0-23)" value={r.toHour} onChange={(e) => update(i, { toHour: e.target.value })} />
                <Textfield placeholder="Timezone" value={r.timezone} onChange={(e) => update(i, { timezone: e.target.value })} />
              </Inline>
            </Stack>
          ) : null}
          <Text size="small" color="color.text.subtle">
            Preview: {describeConstraint(toConstraint(r), reach === 'connected' ? undefined : previewScope, enforcement, previewOpts)}
          </Text>
          {rows.length > 1 ? (
            <Button appearance="subtle" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
              Remove rule
            </Button>
          ) : null}
        </Stack>
      ))}
      <Button appearance="subtle" onClick={() => setRows((rs) => [...rs, emptyRow()])}>
        Add another rule
      </Button>
      {impact ? <ImpactList report={impact} /> : null}
      <ButtonGroup>
        <Button isDisabled={busy} onClick={checkImpact}>
          Check impact on open work
        </Button>
        <Button appearance="primary" isDisabled={busy} onClick={submit}>
          {base ? 'Supersede decision' : 'Record decision'}
        </Button>
        {props.onCancel ? (
          <Button appearance="subtle" onClick={props.onCancel}>
            Cancel
          </Button>
        ) : null}
      </ButtonGroup>
      {owner !== props.me ? (
        <Text size="small">The owner will need to accept this decision before it is enforced.</Text>
      ) : null}
    </Stack>
  );
}
