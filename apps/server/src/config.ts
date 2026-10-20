import { z } from 'zod';

/**
 * Configuration (FRM-REQ-006).
 *
 * A missing secret is a refusal to boot, not a warning and not a generated default. The failure
 * mode this prevents is the expensive one: a half-working instance that serves requests, signs
 * cookies with a value nobody chose, and looks healthy.
 */

/** 32 random bytes, base64. Anything shorter is not a key, whatever it is called. */
const secret = (name: string) =>
  z
    .string()
    .min(1, `${name} is empty`)
    .refine((v) => !PLACEHOLDERS.has(v.trim().toLowerCase()), {
      message: `${name} is still the placeholder from .env.example`,
    })
    .refine((v) => Buffer.from(v, 'base64').length >= 32, {
      message: `${name} must decode to at least 32 bytes (openssl rand -base64 32)`,
    });

const PLACEHOLDERS = new Set(['change-me', 'changeme', 'secret', 'todo', 'xxx']);

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3200),
  BASE_URL: z.url({ error: 'BASE_URL must be an absolute URL' }),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
      message: 'DATABASE_URL must be a postgres:// or postgresql:// URL',
    }),

  /** Key-encryption key: wraps the TOTP secrets at rest. */
  KEK: secret('KEK'),
  /** Server-side pepper, mixed into every password hash. Never stored with the hash. */
  PEPPER: secret('PEPPER'),
  /**
   * Comma-separated, newest first. More than one so a key can be rotated without signing every
   * live session out.
   */
  COOKIE_KEYS: z
    .string()
    .min(1)
    .transform((v) =>
      v
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k.length > 0),
    )
    .refine((keys) => keys.length > 0, { message: 'COOKIE_KEYS has no usable key' })
    .refine((keys) => keys.every((k) => !PLACEHOLDERS.has(k.toLowerCase())), {
      message: 'COOKIE_KEYS still holds the placeholder from .env.example',
    }),

  /**
   * The OIDC path (ADR-004). Optional on purpose: **the app-native path must keep working when
   * these are absent or the issuer is unreachable** (FRM-REQ-017). A clone with no D3 Auth still
   * runs.
   */
  D3AUTH_ISSUER: z.url().optional(),
  /** Accept a loopback http push relay — CI's mock relay only; production relays are https (FRM-T-15.4). */
  RELAY_ALLOW_LOOPBACK_HTTP: z.enum(['0', '1']).optional(),
  D3AUTH_CLIENT_ID: z.string().optional(),
  D3AUTH_CLIENT_SECRET: z.string().optional(),

  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_APP_INSTALLATION_ID: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  MAIL_RELAY_URL: z.url().optional(),
  MAIL_RELAY_TOKEN: z.string().optional(),
  ALERT_TO: z.string().optional(),

  /** ADR-007: the database dump is the only escape hatch, so its directory is not optional. */
  BACKUP_DIR: z.string().default('./backups'),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

  /**
   * Where uploaded files live, each once, named by its SHA-256 (FRM-REQ-190). A directory on the
   * host's disk rather than a column, so images never bloat the database or its nightly dump.
   */
  FOREMAN_BLOB_DIR: z.string().min(1).default('./blobs'),
  /** The largest upload accepted, in bytes (FRM-REQ-191). 10 MiB unless a deployment says otherwise. */
  FOREMAN_BLOB_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),

  /** Where the built console lives. Set in the image; absent in development, where Vite serves it. */
  CONSOLE_DIST: z.string().optional(),

  /**
   * What this deployment is (FRM-ADR-016).
   *
   * `solo` is Foreman as built: one operator, no roles worth enforcing, ideas that become
   * projects. `board` is the innovation-fund deployment: several people, roles that mean
   * something, submissions that get scored, discussed and funded.
   *
   * **A flag rather than a fork**, and a flag rather than a build: the same image runs both, so
   * there is one thing to patch when something is wrong with it. It is deliberately not inferred
   * from anything — a deployment's identity is a decision somebody made, not a consequence of how
   * many accounts happen to exist.
   */
  FOREMAN_MODE: z.enum(['solo', 'board']).default('solo'),

  /** ISO 4217, for rendering a funded amount. Amounts are stored in minor units regardless. */
  CURRENCY: z.string().length(3).default('USD'),

  /** How long an invitation stays usable. Re-issued rather than extended once it lapses. */
  INVITE_TTL_HOURS: z.coerce.number().int().positive().max(720).default(168),

  /** Seeded on first boot so there is an account to log in as. */
  OPERATOR_EMAIL: z.string().optional(),
  OPERATOR_DISPLAY_NAME: z.string().optional(),
});

export type Config = z.infer<typeof Env> & {
  /** True when both halves of the OIDC client are present. */
  readonly oidcConfigured: boolean;
};

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`configuration refused:\n  ${problems.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parse an environment. Pure, so the tests can unset one variable at a time without touching the
 * process.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    // Name the variable in every message: "something is misconfigured" costs an hour.
    const problems = parsed.error.issues.map((issue) => {
      const name = issue.path.join('.');
      if (name.length === 0) return issue.message;
      // "KEK is not set" beats "expected string, received undefined" at 3am.
      const missing = issue.code === 'invalid_type' && /received undefined/.test(issue.message);
      return missing ? `${name} is not set` : `${name}: ${issue.message}`;
    });
    throw new ConfigError(problems);
  }

  const value = parsed.data;
  const oidcConfigured =
    value.D3AUTH_ISSUER !== undefined &&
    value.D3AUTH_CLIENT_ID !== undefined &&
    value.D3AUTH_CLIENT_SECRET !== undefined;

  // A half-configured issuer is worse than none: it fails at the redirect, not at boot.
  if (!oidcConfigured && value.D3AUTH_CLIENT_ID !== undefined) {
    throw new ConfigError([
      'D3AUTH_CLIENT_ID is set but D3AUTH_ISSUER or D3AUTH_CLIENT_SECRET is missing',
    ]);
  }

  return { ...value, oidcConfigured };
}
