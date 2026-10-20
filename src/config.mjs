/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Parse a KEY=VALUE .env file. No interpolation, no quotes handling beyond strip. */
function parseEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

const REQUIRED = ['CTP_PROJECT_KEY', 'CTP_CLIENT_ID', 'CTP_CLIENT_SECRET', 'CTP_AUTH_URL', 'CTP_API_URL'];

/** A problem with how the tool was set up, not a bug. Printed without a stack. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Load one side's credentials. `side` is 'source' or 'target'.
 * Looks at .env.<side> first, then SOURCE_ / TARGET_ prefixed process env.
 */
export function loadCredentials(side) {
  const file = path.join(ROOT, `.env.${side}`);
  const fromFile = parseEnvFile(file);
  const prefix = side.toUpperCase() + '_';
  const merged = {};
  for (const k of REQUIRED.concat(['CTP_SCOPES'])) {
    merged[k] = process.env[prefix + k] || fromFile[k] || '';
  }
  const missing = REQUIRED.filter((k) => !merged[k]);
  if (missing.length) {
    throw new ConfigError(
      `Missing credentials for "${side}": ${missing.join(', ')}.\n` +
        `  Create ${file} with CTP_PROJECT_KEY, CTP_CLIENT_ID, CTP_CLIENT_SECRET,\n` +
        `  CTP_AUTH_URL and CTP_API_URL — the format the Merchant Center hands out —\n` +
        `  or set ${prefix}CTP_* in the environment. See the README.`
    );
  }
  const apiUrl = merged.CTP_API_URL.replace(/\/+$/, '');
  return {
    side,
    projectKey: merged.CTP_PROJECT_KEY,
    clientId: merged.CTP_CLIENT_ID,
    clientSecret: merged.CTP_CLIENT_SECRET,
    authUrl: merged.CTP_AUTH_URL.replace(/\/+$/, ''),
    apiUrl,
    importUrl: process.env[prefix + 'CTP_IMPORT_URL'] || fromFile.CTP_IMPORT_URL || importUrlFor(apiUrl),
    scopes: merged.CTP_SCOPES || '',
  };
}

/**
 * The Import API lives on its own host in the same region: the HTTP API's
 * `api.` becomes `import.`. Both are reached with the same token.
 */
export function importUrlFor(apiUrl) {
  return apiUrl.replace(/^(https?:\/\/)api\./, '$1import.');
}

/** Redact a secret for logs: never print more than the first 4 chars. */
export function redact(s) {
  if (!s) return '';
  return s.slice(0, 4) + '…' + `(${s.length})`;
}
