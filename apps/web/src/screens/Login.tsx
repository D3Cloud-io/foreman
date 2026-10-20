import { type SyntheticEvent, useEffect, useState } from 'react';
import { Alert, Button, FormActions, FormField, Input, PasswordInput, Stack } from '@d3cloud/ui';
import { EntryHeading, EntryNotes, EntryShell } from '../entry/EntryShell';
import { SignInWithD3Auth } from '../entry/SignInWithD3Auth';
import { ApiError, login } from '../lib/api';
import { replaceLocation } from '../lib/router';

/**
 * Two ways in (ADR-004).
 *
 * The password form is the primary one and is always present. Sign in with D3 Auth sits below it,
 * after an "or", only when the server says the provider is **reachable** — a control that leads to
 * a 503 is worse than none at all, and this screen is what someone reaches when the provider is the
 * thing that is broken. FRM-T-13.2: in the split entry shell, after Bindery's and Postroom's front
 * doors; the flow underneath is unchanged.
 */

export interface LoginProps {
  oidcAvailable: boolean;
  onSignedIn: () => void;
}

export function Login({ oidcAvailable, onSignedIn }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  // A refused D3 Auth sign-in comes back as a redirect carrying its reason, because the person is
  // in a browser and never asked for JSON. Read once, then cleared from the URL so a reload or a
  // shared link does not keep re-announcing a failure that already happened.
  const [error, setError] = useState<string | null>(null);
  // Set when the refusal was "an account already holds this address". The remedy is to sign in
  // with the password and *then* link, so the sign-in below finishes by starting the link rather
  // than dropping the person on the portfolio with nothing pointing at the thing they came to do.
  const [linkAfterSignIn, setLinkAfterSignIn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reason = params.get('signin_error');
    if (reason === null) return;
    setError(reason);
    setLinkAfterSignIn(params.get('link_after_signin') === '1');
    // Cleared from the URL so a reload does not re-announce a failure that already happened.
    replaceLocation(window.location.pathname);
  }, []);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);

    void login(email, password, needsTotp ? totpCode : undefined)
      .then((result) => {
        if (result.status === 'totp_required') {
          setNeedsTotp(true);
          return;
        }
        if (linkAfterSignIn) {
          // A real navigation: the server owns this route and answers with a redirect to D3 Auth.
          window.location.assign('/auth/oidc/start?link=1');
          return;
        }
        onSignedIn();
      })
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.status === 429) {
          setError('Too many attempts. Wait a moment and try again.');
          return;
        }
        // One message for every failure, because the server gives one: which half was wrong is
        // information an attacker is welcome to guess at, not to be told.
        setError(
          needsTotp ? 'That code did not match. Try the current one.' : 'Those details did not match.',
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <EntryShell>
      <EntryHeading title="Sign in">
        {needsTotp
          ? 'One more step: the code from your authenticator.'
          : 'Welcome back to the ledger.'}
      </EntryHeading>

      <div className="fm-entry__body">
        {error === null ? null : (
          <Alert tone="danger" title="Sign-in failed" dynamic>
            {error}
          </Alert>
        )}

        <form onSubmit={submit} aria-label={needsTotp ? 'Enter your authentication code' : 'Sign in with your password'}>
          <Stack gap="16">
            {needsTotp ? (
              <FormField label="Authentication code" help="Six digits from your authenticator app.">
                <Input
                  name="totp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  value={totpCode}
                  onChange={(e) => { setTotpCode(e.target.value); }}
                />
              </FormField>
            ) : (
              <>
                <FormField label="Email">
                  <Input
                    name="email"
                    type="email"
                    autoComplete="username"
                    autoFocus
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); }}
                  />
                </FormField>
                <FormField label="Password">
                  <PasswordInput
                    name="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); }}
                  />
                </FormField>
              </>
            )}

            <FormActions layout="stack">
              <Button type="submit" variant="primary" size="lg" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
            </FormActions>
          </Stack>
        </form>

        {/* Below the password form, and only when the provider is reachable (ADR-004). Not on the
            code step: the password half is already done, so the other way in is a detour. */}
        {needsTotp ? null : <SignInWithD3Auth available={oidcAvailable} />}
      </div>

      {needsTotp ? (
        <EntryNotes row>
          <button
            type="button"
            className="fm-entry-link fm-entry-link--quiet"
            onClick={() => {
              setNeedsTotp(false);
              setTotpCode('');
              setError(null);
            }}
          >
            Start over
          </button>
        </EntryNotes>
      ) : (
        <EntryNotes>
          <p>
            {oidcAvailable
              ? 'New here? If D3 Auth lets you in, your account is made the first time you sign in with it. Otherwise, ask whoever runs this Foreman.'
              : 'New here? There is no sign-up page: accounts are made by whoever runs this Foreman.'}
          </p>
        </EntryNotes>
      )}
    </EntryShell>
  );
}
