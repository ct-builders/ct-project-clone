/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import path from 'node:path';
import { log } from './log.mjs';
import { ROOT } from './config.mjs';
import { exportProject, dataDir, readJson } from './export.mjs';
import { IN_ORDER } from './resources.mjs';

/**
 * Matching counts are not a clone. This exports the target through exactly
 * the same normaliser the source went through and diffs the two sets of
 * drafts field by field — so a product that arrived with no prices, or a
 * store pointing at the wrong channel, shows up as a path rather than as a
 * number that happens to agree.
 */

/** Fields that legitimately differ between the two sides. */
const EXPECTED_DIFFS = [
  // The importer sets one password for everybody; the source's is a hash the
  // API never returns.
  /^customers\.[^.]+\.password$/,
  // The target generates its own address, tax-rate and asset ids.
  /\.addresses\.\d+\.id$/,
  /\.rates\.\d+\.id$/,
  // Order import records its own timestamps and version counters.
  /^orders\.[^.]+\.(createdAt|lastModifiedAt|completedAt)$/,
  // Carried on the export for reporting, never sent.
  /^orders\.[^.]+\._lossy/,
  // The Order Import API creates every order External-taxed. See
  // ORDER_TAX_MODE_NOTE — each affected order records it in its _lossy list.
  /^taxMode$/,
];

const expected = (p) => EXPECTED_DIFFS.some((re) => re.test(p));

/** Sort arrays whose order the API does not preserve, so a diff is meaningful. */
function canonical(value, atPath = '') {
  if (Array.isArray(value)) {
    const mapped = value.map((v, i) => canonical(v, `${atPath}[]`));
    if (UNORDERED.some((re) => re.test(atPath))) {
      return [...mapped].sort((a, b) => stable(a).localeCompare(stable(b)));
    }
    return mapped;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k], atPath ? `${atPath}.${k}` : k);
    return out;
  }
  return value;
}

const UNORDERED = [
  /prices$/,
  /categories$/,
  /distributionChannels$/,
  /supplyChannels$/,
  /productSelections$/,
  /attributes$/,
  /rates$/,
  /locations$/,
  /taxPortions$/,
  /transitions$/,
  /resourceTypeIds$/,
  /shippingAddresses$/,
  /billingAddresses$/,
  /stores$/,
  /roles$/,
];

const stable = (v) => JSON.stringify(v);

/** Every leaf path where two values disagree. */
function diff(a, b, at = '', out = []) {
  if (out.length > 200) return out;
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;

  if (ta !== tb) {
    if (!expected(at)) out.push({ path: at, source: brief(a), target: brief(b) });
    return out;
  }
  if (ta === 'array') {
    if (a.length !== b.length) {
      if (!expected(at)) out.push({ path: `${at}.length`, source: a.length, target: b.length });
      return out;
    }
    for (let i = 0; i < a.length; i++) diff(a[i], b[i], `${at}.${i}`, out);
    return out;
  }
  if (ta === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diff(a[k], b[k], at ? `${at}.${k}` : k, out);
    }
    return out;
  }
  if (a !== b && !expected(at)) out.push({ path: at, source: brief(a), target: brief(b) });
  return out;
}

const brief = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? 'absent' : String(s).slice(0, 80);
};

export async function deepVerify(source, target, { reexport = true } = {}) {
  const srcDir = dataDir(source.projectKey);
  const tgtDir = path.join(ROOT, 'data', `${target.projectKey}--verify`);

  if (reexport) {
    log.step(`re-exporting ${target.label} for comparison`);
    await exportProject(target, { dir: tgtDir, options: { customerPassword: null } });
  }

  const report = [];
  for (const r of IN_ORDER) {
    const src = readJson(path.join(srcDir, `${r.name}.json`), []);
    const tgt = readJson(path.join(tgtDir, `${r.name}.json`), []);
    if (!src.length) continue;

    const byIdentity = new Map(tgt.map((row) => [row._identity, row.draft]));
    const rows = { resource: r.name, compared: 0, identical: 0, differing: 0, absent: 0, samples: [] };

    for (const row of src) {
      const other = byIdentity.get(row._identity);
      if (!other) {
        rows.absent++;
        if (rows.samples.length < 5) rows.samples.push({ identity: row._identity, diffs: [{ path: '(whole entity)', source: 'present', target: 'absent' }] });
        continue;
      }
      rows.compared++;
      const d = diff(canonical(strippedForCompare(r.name, row.draft)), canonical(strippedForCompare(r.name, other)));
      const real = d.filter((x) => !expected(`${r.name}.${row._identity}.${x.path}`) && !expected(x.path));
      if (!real.length) rows.identical++;
      else {
        rows.differing++;
        if (rows.samples.length < 5) rows.samples.push({ identity: row._identity, diffs: real.slice(0, 6) });
      }
    }
    report.push(rows);
  }
  return { report, targetDir: tgtDir };
}

/** Drop the fields that exist only to carry information through the run. */
function strippedForCompare(resourceName, draft) {
  const out = { ...draft };
  delete out._lossy;
  if (resourceName === 'customers') delete out.password;
  if (resourceName === 'orders') delete out._payments;
  return out;
}

export function renderDeepVerify({ report }) {
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  const lines = ['', `${pad('resource', 24)}${padL('same', 7)}${padL('differ', 8)}${padL('absent', 8)}`, '-'.repeat(47)];
  let totalDiff = 0;
  for (const r of report) {
    lines.push(`${pad(r.resource, 24)}${padL(r.identical, 7)}${padL(r.differing || '', 8)}${padL(r.absent || '', 8)}`);
    totalDiff += r.differing + r.absent;
  }
  for (const r of report) {
    if (!r.samples.length) continue;
    lines.push('', `${r.resource}`);
    for (const s of r.samples) {
      lines.push(`  ${s.identity}`);
      for (const d of s.diffs) lines.push(`    ${d.path}: source=${d.source}  target=${d.target}`);
    }
  }
  lines.push('', totalDiff ? `${totalDiff} entities differ from the source.` : 'Every entity matches the source field for field.');
  return lines.join('\n');
}
