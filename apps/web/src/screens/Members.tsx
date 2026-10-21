import { useCallback, useState, type SyntheticEvent } from 'react';
import {
  Alert,
  Button,
  EmptyState,
  FormActions,
  FormField,
  Input,
  Modal,
  Page,
  PageHeader,
  Select,
  Skeleton,
  Stack,
  Table,
} from '@d3cloud/ui';
import { foreman, ApiError, type MemberRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { Pill } from '../ui/viz';
import { relativeDay } from '../ui/tone';
import { priorityColumns, usePhone, type PriorityColumn } from '../ui/tablePriority';

/**
 * Who is on the board (FRM-ADR-016, FRM-REQ-165).
 *
 * Admin-only, and absent entirely on a solo instance — a Foreman with one operator has nobody to
 * administer, and a screen that manages a list of one is a screen that invites somebody to add to
 * it.
 */

const ROLES = [
  { value: 'admin', label: 'Admin', detail: 'Everything, plus managing members' },
  { value: 'reviewer', label: 'Reviewer', detail: 'Sees every submission, scores, decides' },
  { value: 'submitter', label: 'Submitter', detail: 'Submits and discusses; edits their own' },
] as const;

export function Members() {
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => { setNonce((n) => n + 1); }, []);
  const { state } = useAsync(() => foreman.members(), [nonce]);

  // Below 768px: the person is the title and their role select stays; status (and what is pending
  // on it) and the suspend control fold into the sub-line under them (FRM-REQ-249).
  const memberColumns: PriorityColumn<MemberRow>[] = [
    {
      key: 'name',
      header: 'Name',
      sortable: true,
      phone: 'host',
      cell: (row) => (
        <Stack gap="2">
          <strong>{row.displayName}</strong>
          <span className="fm-muted">{row.email}</span>
        </Stack>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      width: '12rem',
      phoneWidth: '8.5rem',
      cell: (row) => <RoleControl member={row} onChanged={refresh} />,
    },
    {
      key: 'status',
      header: 'Status',
      width: '14rem',
      phone: 'fold',
      foldLabel: '',
      cell: (row) => (
        <Stack gap="2">
          <Pill tone={row.status === 'active' ? 'success' : row.status === 'invited' ? 'warning' : 'danger'}>
            {row.status}
          </Pill>
          {/* An invitation nobody accepted is the thing an admin actually wants to see here: it
              looks identical to a working account until somebody asks why they cannot sign in. */}
          {/* Suspended because they asked to delete their account (FRM-ADR-022): the same row, a
              different story, and Restore is how it is undone. */}
          {row.status === 'suspended' && (row.deleteAfter ?? null) !== null && (
            <span className="fm-muted">
              deleting on {new Date(row.deleteAfter ?? '').toLocaleDateString(undefined, { dateStyle: 'medium' })} — Restore
              cancels it
            </span>
          )}
          {row.status === 'invited' && row.invite !== null && (
            <span className="fm-muted">
              invited, expires {new Date(row.invite.expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
            </span>
          )}
        </Stack>
      ),
    },
    {
      key: 'actions',
      header: 'Access',
      width: '9rem',
      phone: 'fold',
      foldLabel: '',
      cell: (row) => <SuspendControl member={row} onChanged={refresh} />,
    },
  ];

  const columns = priorityColumns(memberColumns, usePhone());

  return (
    <Page>
      <PageHeader
        title="Members"
        description="Who can submit, who can decide, and who can change that."
        {...(state.status === 'ready' ? { count: state.value.items.length } : {})}
        countNoun={{ one: 'member', other: 'members' }}
        actions={<InviteForm onInvited={refresh} />}
      />

      {state.status === 'loading' ? (
        <Skeleton lines={6} />
      ) : state.status === 'error' ? (
        <EmptyState kind="error" heading="The members did not load">
          {state.message}
        </EmptyState>
      ) : (
        <Table
          caption="Members"
          captionHidden
          density="compact"
          columns={columns}
          rows={state.value.items}
          rowKey={(row) => row.id}
        />
      )}
    </Page>
  );
}

function RoleControl({ member, onChanged }: { member: MemberRow; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Stack gap="4">
      <Select
        aria-label={`Role for ${member.displayName}`}
        options={ROLES.map((r) => ({ value: r.value, label: r.label }))}
        value={member.role}
        disabled={busy}
        onValueChange={(role) => {
          setBusy(true);
          setError(null);
          void foreman
            .updateMember(member.id, { role })
            .then(onChanged)
            .catch((caught: unknown) => {
              // The refusal worth surfacing here is the last-admin one, and its message already
              // says what to do about it.
              setError(caught instanceof ApiError ? caught.message : 'That did not change.');
            })
            .finally(() => { setBusy(false); });
        }}
      />
      {error !== null && <span className="fm-item__reason">{error}</span>}
    </Stack>
  );
}

function SuspendControl({ member, onChanged }: { member: MemberRow; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const suspended = member.status === 'suspended';

  return (
    <Button
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void foreman
          .updateMember(member.id, { suspended: !suspended })
          .then(onChanged)
          .catch(() => undefined)
          .finally(() => { setBusy(false); });
      }}
    >
      {suspended ? 'Restore' : 'Suspend'}
    </Button>
  );
}

/**
 * Inviting somebody.
 *
 * The link is shown as well as emailed, deliberately. Mail is the convenient path and not the
 * reliable one, and an admin who cannot see the link has no way to tell a bounced invitation from
 * one sitting unread.
 */
function InviteForm({ onInvited }: { onInvited: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<string>('submitter');
  const [issued, setIssued] = useState<{ acceptUrl: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    void foreman
      .inviteMember({ email, displayName, role })
      .then((result) => {
        setIssued({ acceptUrl: result.acceptUrl, expiresAt: result.expiresAt });
        onInvited();
      })
      .catch((caught: unknown) => {
        setError(caught instanceof ApiError ? caught.message : 'That invitation was not sent.');
      })
      .finally(() => { setBusy(false); });
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setEmail('');
          setDisplayName('');
          setRole('submitter');
          setIssued(null);
          setError(null);
        }
      }}
      trigger={<Button variant="primary">Invite</Button>}
      title={issued === null ? 'Invite somebody' : 'Invitation ready'}
    >
      {issued !== null ? (
        <Stack gap="16">
          <Alert tone="info" title="Send them this link">
            It has also been emailed, if a relay is configured. It works once and expires{' '}
            {relativeDay(issued.expiresAt)}.
          </Alert>
          {/* Selectable text rather than a copy button: a copy button that silently fails is
              worse than a string somebody can see they have selected. */}
          <code className="fm-secret">{issued.acceptUrl}</code>
          <FormActions>
            <Button variant="primary" onClick={() => { setOpen(false); }}>
              Done
            </Button>
          </FormActions>
        </Stack>
      ) : (
        <form onSubmit={submit}>
          <Stack gap="16">
            {error !== null && (
              <Alert tone="danger" title="That did not send" dynamic>
                {error}
              </Alert>
            )}
            <FormField label="Email">
              <Input
                name="email"
                type="email"
                value={email}
                onChange={(e) => { setEmail(e.target.value); }}
              />
            </FormField>
            <FormField label="Name">
              <Input
                name="displayName"
                value={displayName}
                onChange={(e) => { setDisplayName(e.target.value); }}
              />
            </FormField>
            <FormField
              label="Role"
              help={ROLES.find((r) => r.value === role)?.detail}
            >
              <Select
                options={ROLES.map((r) => ({ value: r.value, label: r.label }))}
                value={role}
                onValueChange={setRole}
              />
            </FormField>
            <FormActions>
              <Button type="button" onClick={() => { setOpen(false); }}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={busy || email.length === 0 || displayName.length === 0}
              >
                {busy ? 'Inviting…' : 'Invite'}
              </Button>
            </FormActions>
          </Stack>
        </form>
      )}
    </Modal>
  );
}
