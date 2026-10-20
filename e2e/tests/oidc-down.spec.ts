import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * FRM-REQ-017, end to end: **with D3 Auth unreachable, the password path still signs in** — with
 * the second factor, because that is the whole app-native path, not half of it (FRM-T-025).
 *
 * CI runs the stack with `docker-compose.e2e.yml`, which configures D3 Auth at an issuer that
 * refuses every connection. The server's discovery fails at boot and it starts anyway; this spec
 * checks it really is in that state before relying on it, so a stack with no provider configured at
 * all cannot pass it by accident.
 *
 * The account is not the operator. Enrolling an authenticator is one-way here, and every other spec
 * signs the operator in with a password alone, so CI seeds a second account for this one.
 */

const EMAIL = process.env['E2E_TOTP_EMAIL'];
const PASSWORD = process.env['E2E_TOTP_PASSWORD'];
const IN_CI = process.env['CI'] !== undefined;

// ─── TOTP (RFC 6238), as the server's otpauth configures it: SHA-1, six digits, 30 s ─────────────

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error(`not base32: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secret: string, at: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, '0');
}

/**
 * The account's TOTP secret: enrolled here the first time, and kept beside the run so a retry —
 * which finds the account already enrolled and can no longer reach the enrolment route without a
 * code — can still produce one.
 */
async function enrolledSecret(request: APIRequestContext, email: string, password: string): Promise<string> {
  const stash = join(tmpdir(), `foreman-e2e-totp-${email.replace(/[^a-z0-9]/gi, '_')}.txt`);

  const login = await request.post('/auth/login', { data: { email, password } });
  expect(login.status(), 'the TOTP account should exist — CI seeds it').toBe(200);
  const { status } = (await login.json()) as { status: string };

  if (status === 'totp_required') {
    expect(existsSync(stash), 'enrolled by an earlier run whose secret is gone').toBe(true);
    return readFileSync(stash, 'utf8').trim();
  }

  expect(status).toBe('signed_in');
  const enrol = await request.post('/auth/totp/enrol');
  expect(enrol.status()).toBe(200);
  const { secret } = (await enrol.json()) as { secret: string };
  const confirm = await request.post('/auth/totp/confirm', { data: { code: totp(secret, Date.now()) } });
  expect(confirm.status(), 'the confirmation code should match').toBe(204);
  writeFileSync(stash, secret, { mode: 0o600 });
  await request.post('/auth/logout');
  return secret;
}

test.describe('D3 Auth unreachable (FRM-REQ-017)', () => {
  test.skip(
    !IN_CI && (EMAIL === undefined || PASSWORD === undefined),
    'set E2E_TOTP_EMAIL and E2E_TOTP_PASSWORD to an account the seed made (CI does)',
  );

  test('the server is configured for D3 Auth and knows it cannot reach it', async ({ request }) => {
    const health = await request.get('/health');
    expect(health.ok()).toBe(true);
    const body = (await health.json()) as { oidcConfigured: boolean; oidcReachable: boolean };
    expect(body.oidcConfigured, 'the stack must configure an issuer for this to mean anything').toBe(true);
    expect(body.oidcReachable).toBe(false);

    const anonymous = await request.get('/auth/session');
    expect(anonymous.status()).toBe(401);
    expect(((await anonymous.json()) as { oidcAvailable: boolean }).oidcAvailable).toBe(false);

    // And the route the button would lead to refuses outright rather than redirecting at a dead host.
    const start = await request.get('/auth/oidc/start', { maxRedirects: 0 });
    expect(start.status()).toBe(503);
  });

  test('signs in with email, password and a TOTP code, and offers no D3 Auth button', async ({
    page,
    request,
  }) => {
    const email = EMAIL ?? '';
    const password = PASSWORD ?? '';
    const secret = await enrolledSecret(request, email, password);

    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in', exact: true })).toBeVisible();
    // Absent, not merely disabled: a control that leads to a 503 is worse than none (ADR-004).
    await expect(page.getByRole('link', { name: /D3 Auth/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /D3 Auth/ })).toHaveCount(0);

    await page.getByRole('textbox', { name: 'Email' }).fill(email);
    await page.getByRole('textbox', { name: 'Password' }).fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // The second step: the code from the authenticator.
    const code = page.getByRole('textbox', { name: 'Authentication code' });
    await expect(code).toBeVisible();
    await expect(page.getByRole('link', { name: /D3 Auth/ })).toHaveCount(0);
    // The next step's code: inside the server's one-step window, and always later than the step
    // the enrolment just spent, which the server will not accept twice.
    await code.fill(totp(secret, Date.now() + 30_000));
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('navigation').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Home' })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();

    // A real session, made by the password path, with D3 Auth still down.
    const session = await page.request.get('/auth/session');
    expect(session.status()).toBe(200);
    const me = (await session.json()) as { user: { email: string }; totpEnrolled: boolean; oidcAvailable: boolean };
    expect(me.user.email).toBe(email);
    expect(me.totpEnrolled).toBe(true);
    expect(me.oidcAvailable).toBe(false);
  });
});
