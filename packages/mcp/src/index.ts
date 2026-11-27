#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from './client.js';
import { createServer } from './server.js';

/**
 * `@d3cloud/foreman-mcp` — the stdio shim (ADR-003).
 *
 * A small process Claude launches. It holds a scoped Foreman API token and translates MCP calls
 * into HTTPS requests, which means **there is no public MCP endpoint to attack** and none of the
 * remote-authorization surface has to exist. The honest cost: it only works where it is installed.
 *
 *   FOREMAN_URL=https://foreman.d3cloud.io FOREMAN_TOKEN=… foreman-mcp
 */

/**
 * Unset and empty are the same failure. A client config that defines the variable but leaves the
 * value blank is common, and `''` would otherwise pass an `=== undefined` guard and start a server
 * that can never work — Claude connects, and every call fails obscurely much later.
 */
const required = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
};

const baseUrl = required('FOREMAN_URL');
const token = required('FOREMAN_TOKEN');

if (baseUrl === undefined || token === undefined) {
  // stderr, never stdout: stdout is the protocol channel, and a stray line there is a parse error
  // at the other end rather than a message anyone reads.
  process.stderr.write(
    'foreman-mcp: set FOREMAN_URL and FOREMAN_TOKEN.\n' +
      '  FOREMAN_URL=https://foreman.d3cloud.io\n' +
      '  FOREMAN_TOKEN=<a scoped token from Foreman>\n',
  );
  process.exit(1);
}

/**
 * The one capability the shim has that the remote `/mcp` must not: reading a file on this machine,
 * for `foreman_update { attach }` (FRM-ADR-026). `~/` is the operator's home, and a relative path
 * is relative to where Claude launched the shim.
 */
const readLocal = async (path: string): Promise<Uint8Array> =>
  readFile(path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(path));

const server = createServer({ client: createClient({ baseUrl, token }), readFile: readLocal });
await server.connect(new StdioServerTransport());
