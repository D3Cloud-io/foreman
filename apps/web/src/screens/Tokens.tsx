import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Cluster,
  EmptyState,
  FormActions,
  FormField,
  Grid,
  Input,
  Modal,
  Page,
  PageHeader,
  Section,
  Skeleton,
  Stack,
} from '@d3cloud/ui';
import { foreman, type IssuedToken, type SignedInSession, type TokenRow } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useDraftGuard, useMutate } from '../lib/mutate';
import { Pill, StatCard } from '../ui/viz';
import { relativeDay } from '../ui/tone';

/**
 * Scoped API tokens (FRM-REQ-025, FRM-REQ-026, FRM-REQ-027).
 *
 * The routes have existed since P2 and nothing in the console reached them, so the only way to
 * mint a token was `issue-token` over SSH on the host. That made the one credential the audit and
 * planning skills need — `FOREMAN_WRITE_TOKEN` — something you could not obtain from the tool that
 * issues it, which is the same shape of gap as Bindery's Phase 20 shipping its provider settings
 * only as a compose file to edit over SSH.
 *
 * Three rules the screen is built around, each of them the API's rule made visible:
 *
 * - **The secret is shown once.** No route returns it again. The dialog says so before you close
 *   it, and closing it is the only way out — there is no "show me again" to look for later.
 * - **Read is the default.** Write is a deliberate tick, because a token that can write is a
 *   token that can rewrite the plan, and the path of least resistance should not be the powerful
 *   one.
 * - **Revoked is a state, not a deletion.** A revoked row stays visible: "this token existed and
 *   was turned off" is what you want to read six months later, and a row that vanishes tells you
 *   nothing about whether it was ever there.
 * - **Revoking asks first, because it cannot be undone** (FRM-T-18.4, the destructive ladder). The
 *   server's undo does not reach `api_token`, so the one thing the console can do is say what is
 *   about to stop working before it does. Everything that *can* be undone acts at once instead.
 */

/** The confirm's sentence: what stops working, and that there is no way back. */
export function revokeConsequence(prefix: string): string {
  return `Agents using ${prefix}… stop working at once. This cannot be undone.`;
}

const SCOPES = [
  { value: 'read', label: 'Read', detail: 'Answer questions. Every GET.' },
  { value: 'write', label: 'Write', detail: 'Create and change records.' },
  { value: 'admin', label: 'Admin', detail: 'Manage tokens and accounts.' },
];

function scopeTone(scope: string) {
  return scope === 'admin' ? 'danger' : scope === 'write' ? 'warning' : 'neutral';
}

/** Live, revoked, or expired — the three states a row can be in, decided in one place. */
function stateOf(row: TokenRow): { label: string; tone: 'success' | 'neutral' | 'warning' } {
  if (row.revokedAt !== null) return { label: 'revoked', tone: 'neutral' };
  if (row.expiresAt !== null && new Date(row.expiresAt).getTime() < Date.now()) {
    return { label: 'expired', tone: 'warning' };
  }
  return { label: 'active', tone: 'success' };
}

export function Tokens() {
  const { state, refresh } = useAsync(() => foreman.tokens(), []);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [revoking, setRevoking] = useState<TokenRow | null>(null);

  const rows = state.status === 'ready' ? state.value.items : [];
  const active = rows.filter((row) => stateOf(row).label === 'active');
  const writers = active.filter((row) => row.scopes.includes('write') || row.scopes.includes('admin'));

  const onIssued = useCallback(
    (token: IssuedToken) => {
      setCreating(false);
      setIssued(token);
      refresh();
    },
    [refresh],
  );

  return (
    <Page>
      <PageHeader
        title="API tokens"
        description="For the MCP shim, the audit skills, and anything that talks to Foreman without a browser."
        {...(state.status === 'ready'
          ? { count: active.length, countNoun: { one: 'active token', other: 'active tokens' } }
          : {})}
        actions={
          <Button variant="primary" onClick={() => { setCreating(true); }}>
            Issue a token
          </Button>
        }
      />

      <Stack gap="24">
        <Grid minItemWidth="sm">
          <StatCard label="Active" value={active.length} detail="Usable right now" />
          <StatCard
            label="Can write"
            value={writers.length}
            tone={writers.length === 0 ? 'neutral' : 'warning'}
            detail="Able to change the plan"
          />
          <StatCard
            label="Revoked or expired"
            value={rows.length - active.length}
            detail="Kept, so the history reads"
          />
        </Grid>

        <Section title="Every token" surface="card">
          {state.status === 'loading' ? (
            <Skeleton lines={4} />
          ) : state.status === 'error' ? (
            <EmptyState kind="error" heading="The tokens did not load">
              {state.message}
            </EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState kind="empty" size="inline" heading="No tokens yet">
              Issue one for the MCP shim, or for the audit skills to write findings with.
            </EmptyState>
          ) : (
            <Stack gap="8">
              {rows.map((row) => {
                const here = stateOf(row);
                return (
                  <Card key={row.id} padding="sm">
                    <Cluster gap="12" align="center" justify="between">
                      <Stack gap="4">
                        <Cluster gap="8" align="center">
                          <span className="fm-card__title">{row.name}</span>
                          <Pill tone={here.tone} dot>
                            {here.label}
                          </Pill>
                        </Cluster>
                        <Cluster gap="8" align="center">
                          <code className="fm-card__code">{row.prefix}…</code>
                          {row.scopes.map((scope) => (
                            <Pill key={scope} tone={scopeTone(scope)}>
                              {scope}
                            </Pill>
                          ))}
                        </Cluster>
                        <span className="fm-muted">
                          {/* "Never used" is worth saying plainly: it is how you find the token
                              you issued, pasted wrong, and replaced without revoking. */}
                          {row.lastUsedAt === null
                            ? 'never used'
                            : `last used ${relativeDay(row.lastUsedAt)}`}
                          {' · '}
                          issued {relativeDay(row.createdAt)}
                          {row.expiresAt === null ? '' : ` · expires ${relativeDay(row.expiresAt)}`}
                        </span>
                      </Stack>
                      {row.revokedAt === null && (
                        <Button
                          aria-label={`Revoke ${row.name}`}
                          onClick={() => { setRevoking(row); }}
                        >
                          Revoke
                        </Button>
                      )}
                    </Cluster>
                  </Card>
                );
              })}
            </Stack>
          )}
        </Section>
      </Stack>

      <SignedIn />

      <IssueDialog open={creating} onClose={() => { setCreating(false); }} onIssued={onIssued} />
      <RevokeDialog row={revoking} onClose={() => { setRevoking(null); }} onRevoked={refresh} />
      <ShownOnceDialog issued={issued} onClose={() => { setIssued(null); }} />
    </Page>
  );
}

function IssueDialog({
  open,
  onClose,
  onIssued,
}: {
  open: boolean;
  onClose: () => void;
  onIssued: (token: IssuedToken) => void;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { mutate } = useMutate();
  const allowClose = useDraftGuard(open ? name.trim().length : 0, 'the new token');

  const toggle = (scope: string, on: boolean) => {
    setScopes((current) =>
      on ? [...new Set([...current, scope])] : current.filter((s) => s !== scope),
    );
  };

  const submit = () => {
    setBusy(true);
    setError(null);
    // No toast: the shown-once dialog that follows is the answer, and it is not one to miss.
    void mutate({
      subject: name.trim(),
      run: () => foreman.issueToken({ name: name.trim(), scopes }),
      message: () => null,
      undoable: false,
      failure: 'inline',
    })
      .then((outcome) => {
        if (!outcome.ok) {
          if (outcome.inFlight !== true) setError(outcome.message);
          return;
        }
        setName('');
        setScopes(['read']);
        onIssued(outcome.value);
      })
      .finally(() => { setBusy(false); });
  };

  return (
    <Modal
      open={open}
      // Escape or the scrim with a name typed asks first; Cancel is the person saying discard.
      onOpenChange={(next) => { if (!next && allowClose()) onClose(); }}
      title="Issue an API token"
      description="Named, scoped, and shown exactly once."
    >
      <Stack gap="16">
        <FormField label="What is it for" help="Named so you can tell two apart a year from now.">
          <Input
            value={name}
            onChange={(event) => { setName(event.target.value); }}
            placeholder="matt's laptop — MCP shim"
          />
        </FormField>

        <Stack gap="8">
          <span className="fm-part__label">Scopes</span>
          {SCOPES.map((scope) => (
            <Stack key={scope.value} gap="2">
              <Checkbox
                checked={scopes.includes(scope.value)}
                onCheckedChange={(next) => { toggle(scope.value, next === true); }}
                label={scope.label}
              />
              <span className="fm-scope__detail">{scope.detail}</span>
            </Stack>
          ))}
        </Stack>

        {scopes.includes('write') || scopes.includes('admin') ? (
          <Alert tone="warning" title="This token will be able to change the plan">
            Give it only to something that should. Revoking takes effect on the next request.
          </Alert>
        ) : null}

        {error !== null && <Alert tone="danger" title="It was not issued">{error}</Alert>}

        <FormActions>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || name.trim().length === 0 || scopes.length === 0}
            onClick={submit}
          >
            {busy ? 'Issuing…' : 'Issue'}
          </Button>
        </FormActions>
      </Stack>
    </Modal>
  );
}

/**
 * Revoke, asked first — the one write on this screen that cannot be undone. It names the token and
 * what stops working, and Keep token is where focus lands (`destructive`), so Enter keeps it.
 */
function RevokeDialog({
  row,
  onClose,
  onRevoked,
}: {
  row: TokenRow | null;
  onClose: () => void;
  onRevoked: () => void;
}) {
  const { mutate, pending } = useMutate();
  const [error, setError] = useState<string | null>(null);
  // Keep token, not the dialog: `destructive` keeps focus off the danger button by focusing the
  // dialog itself, and Enter on the safe choice is the point. Moved after Radix has placed it.
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (row === null) return undefined;
    const frame = requestAnimationFrame(() => {
      keep.current?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [row]);

  const revoke = (target: TokenRow) => {
    setError(null);
    void mutate({
      subject: target.name,
      run: () => foreman.revokeToken(target.id),
      message: () => `Revoked “${target.name}”`,
      refresh: onRevoked,
      // The server cannot put a token back, so the toast offers nothing to press.
      undoable: false,
      // A refusal goes in a toast as well as here, so closing the dialog mid-request loses nothing.
      failure: 'toast',
    }).then((outcome) => {
      if (outcome.ok) onClose();
      else if (outcome.inFlight !== true) setError(outcome.message);
    });
  };

  return (
    <Modal
      open={row !== null}
      onOpenChange={(next) => {
        if (!next) {
          setError(null);
          onClose();
        }
      }}
      destructive
      title={row === null ? '' : `Revoke “${row.name}”?`}
      description={row === null ? undefined : revokeConsequence(row.prefix)}
      footer={
        row === null ? undefined : (
          <>
            <Button ref={keep} onClick={onClose}>
              Keep token
            </Button>
            <Button
              variant="danger"
              loading={pending}
              onClick={() => { revoke(row); }}
            >
              {`Revoke ${row.name}`}
            </Button>
          </>
        )
      }
    >
      {row === null ? null : (
        <Stack gap="12">
          <p>
            To give an agent access again, issue a new token and hand it over. The revoked one stays
            in the list, so the history still reads.
          </p>
          {error === null ? null : (
            <Alert tone="danger" title="It was not revoked" dynamic>
              {error}
            </Alert>
          )}
        </Stack>
      )}
    </Modal>
  );
}

/**
 * The secret, once.
 *
 * Deliberately not auto-dismissed and not copied for you: the one irreversible moment in this
 * screen is closing this dialog, so it says what is about to be lost and makes closing the
 * deliberate act.
 */
function ShownOnceDialog({
  issued,
  onClose,
}: {
  issued: IssuedToken | null;
  onClose: () => void;
}) {
  return (
    <Modal
      open={issued !== null}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={issued === null ? '' : `“${issued.name}” is ready`}
      description="This is the only time it is shown. No route returns it again."
    >
      {issued !== null && (
        <Stack gap="16">
          <pre className="fm-secret">{issued.token}</pre>
          <Alert tone="warning" title="Copy it before you close this">
            Foreman stores only a hash. If you lose it, issue another and revoke this one.
          </Alert>
          <Stack gap="4">
            <span className="fm-part__label">For the audit and planning skills</span>
            <pre className="fm-secret fm-secret--quiet">
              {`export FOREMAN_URL=${window.location.origin}\nexport FOREMAN_WRITE_TOKEN=${issued.token}`}
            </pre>
          </Stack>
          <FormActions>
            <Button variant="primary" onClick={onClose}>
              I have copied it
            </Button>
          </FormActions>
        </Stack>
      )}
    </Modal>
  );
}

/** A session's name: the phone's own, or the browser's. */
function sessionName(row: SignedInSession): string {
  if (row.deviceName !== null && row.deviceName !== '') return row.deviceName;
  if (row.current) return 'This browser';
  return row.native ? 'D3 Constellation' : 'A browser';
}

/**
 * Where this account is signed in (FRM-T-14.4) — beside the tokens because it is the same question,
 * "what can act as me?", about people rather than credentials. Ending a session signs it out at
 * once; a phone finds out at its next refresh.
 */
function SignedIn() {
  const { state, refresh } = useAsync(() => foreman.sessions(), []);
  const { mutate } = useMutate();
  return (
    <Section title="Signed in" description="Everywhere this account is signed in. End any you don’t recognise." surface="card">
      {state.status === 'loading' ? <Skeleton lines={2} /> : null}
      {state.status === 'error' ? <Alert tone="danger">{state.message}</Alert> : null}
      {state.status === 'ready' ? (
        <Stack gap="8">
          {state.value.map((row) => (
            <Card key={row.id}>
              <Cluster justify="between" align="center">
                <Stack gap="4">
                  <strong>{sessionName(row)}</strong>
                  <span>
                    {row.native ? 'App' : row.method === 'oidc' ? 'D3 Auth' : 'Password'} · signed in {relativeDay(row.createdAt)}
                    {row.ip === null ? '' : ` · ${row.ip}`}
                  </span>
                </Stack>
                {row.current ? (
                  <Pill tone="neutral">This one</Pill>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Sign out ${sessionName(row)}`}
                    onClick={() => {
                      // Not undoable — a session ended is ended — but signing in again is the way
                      // back, so it acts at once and says so.
                      void mutate({
                        subject: sessionName(row),
                        run: () => foreman.endSession(row.id),
                        message: () => `Signed out ${sessionName(row)}`,
                        refresh,
                        undoable: false,
                      });
                    }}
                  >
                    Sign out
                  </Button>
                )}
              </Cluster>
            </Card>
          ))}
        </Stack>
      ) : null}
    </Section>
  );
}
