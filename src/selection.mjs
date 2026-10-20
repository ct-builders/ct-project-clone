/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ConfigError } from './config.mjs';
import { RESOURCES, NOT_CLONED } from './resources.mjs';
import { log } from './log.mjs';

export const CONFIG_FILE = 'ctclone.config.json';

/**
 * Not a resource, but selectable like one: the target's languages, countries
 * and currencies. Every other write is rejected if the target does not speak
 * them, so it is part of a selection rather than a separate switch.
 */
export const PROJECT_SETTINGS = '_project';

const CLONEABLE = RESOURCES.map((r) => r.name);
const INERT = NOT_CLONED.map((r) => r.name);

/** Everything a selection may name. Includes the resources that are never
 *  cloned, so naming one is an inert choice rather than a misspelling. */
const KNOWN = new Set([PROJECT_SETTINGS, ...CLONEABLE, ...INERT]);

/** Everything a selection resolves to when nothing is taken away. */
export const SELECTABLE = [PROJECT_SETTINGS, ...CLONEABLE];

/** Levenshtein, capped — only ever run over ~35 short names. */
function distance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function suggest(name) {
  const near = [...KNOWN]
    .map((k) => [k, distance(name, k)])
    .filter(([, d]) => d <= 3)
    .sort((x, y) => x[1] - y[1]);
  return near.length ? near[0][0] : null;
}

/**
 * A name that is not a resource is a mistake worth stopping for. Without this
 * a typo silently selects nothing and the run reports success having copied
 * nothing at all.
 */
function assertKnown(names, where) {
  const unknown = names.filter((n) => !KNOWN.has(n));
  if (!unknown.length) return;
  const lines = unknown.map((n) => {
    const did = suggest(n);
    return `  "${n}"${did ? ` — did you mean "${did}"?` : ''}`;
  });
  throw new ConfigError(
    `${where} names ${unknown.length} unknown resource${unknown.length > 1 ? 's' : ''}:\n` +
      lines.join('\n') +
      `\n\n  Valid names:\n    ${SELECTABLE.join(', ')}\n` +
      `\n  Never cloned, and inert in a selection:\n    ${INERT.join(', ')}`
  );
}

/** Naming a resource the tool never clones is legal and does nothing. Say so
 *  rather than leaving the operator to wonder why it did not appear. */
function warnInert(names, where) {
  const inert = names.filter((n) => INERT.includes(n));
  if (inert.length) log.warn(`${where}: ${inert.join(', ')} ${inert.length > 1 ? 'are' : 'is'} never cloned — ignored`);
}

/**
 * Read the config file. Absent is not an error: the file is optional and its
 * absence means "no selection configured".
 */
export function loadConfigFile(file) {
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${file} is not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${file} must contain a JSON object.`);
  }
  const resources = parsed.resources;
  if (resources === undefined) return { include: null, exclude: null };
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    throw new ConfigError(`${file}: "resources" must be an object with "include" or "exclude".`);
  }
  for (const k of ['include', 'exclude']) {
    if (resources[k] !== undefined && !Array.isArray(resources[k])) {
      throw new ConfigError(`${file}: "resources.${k}" must be an array of resource names.`);
    }
  }
  if (resources.include && resources.exclude) {
    throw new ConfigError(`${file}: set "resources.include" or "resources.exclude", not both.`);
  }
  return { include: resources.include || null, exclude: resources.exclude || null };
}

function apply({ include, exclude }, where) {
  const named = include || exclude || [];
  assertKnown(named, where);
  warnInert(named, where);
  const selected = include
    ? SELECTABLE.filter((n) => include.includes(n))
    : SELECTABLE.filter((n) => !exclude.includes(n));
  if (!selected.length) {
    throw new ConfigError(`${where} selects no resources — there would be nothing to do.`);
  }
  return selected;
}

/**
 * Work out which resources a run covers.
 *
 * Returns `null` when nothing is configured anywhere, which every stage reads
 * as "everything, with that stage's own defaults" — keyfix in particular skips
 * orders by default, and an explicit list naming them would try to key them.
 *
 * Command-line flags replace the file rather than merging with it: one place
 * decides which resources a run covers, and a flag is the more deliberate of
 * the two.
 */
export function resolveSelection({ only = null, exclude = null, configPath = null } = {}) {
  if (only && exclude) {
    throw new ConfigError('--only and --exclude cannot be used together.');
  }
  if (only || exclude) {
    return { names: apply({ include: only, exclude }, only ? '--only' : '--exclude'), from: 'flag' };
  }

  const file = configPath ? path.resolve(configPath) : path.join(ROOT, CONFIG_FILE);
  if (configPath && !fs.existsSync(file)) {
    throw new ConfigError(`--config ${configPath} does not exist.`);
  }
  const config = loadConfigFile(file);
  if (!config || (!config.include && !config.exclude)) return { names: null, from: 'default' };

  return { names: apply(config, path.basename(file)), from: file };
}
