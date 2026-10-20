/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import path from 'node:path';
import { log } from './log.mjs';
import { IN_ORDER, NOT_CLONED } from './resources.mjs';
import { dataDir, readJson } from './export.mjs';

/**
 * A clone that reported no errors and a clone that actually landed are
 * different claims. Verify counts both sides and compares key sets, so the
 * closing report can name what is missing rather than assert success.
 */
export async function verify(source, target, { sourceDir = null } = {}) {
  const inDir = sourceDir || dataDir(source.projectKey);
  log.step(`verify ${source.label} -> ${target.label}`);

  const rows = [];
  for (const r of IN_ORDER) {
    const [srcKeys, tgtKeys] = await Promise.all([identities(source, r), identities(target, r)]);
    if (srcKeys === null) continue;
    const missing = [...srcKeys].filter((k) => !tgtKeys.has(k));
    const extra = [...tgtKeys].filter((k) => !srcKeys.has(k));
    rows.push({
      resource: r.name,
      source: srcKeys.size,
      target: tgtKeys.size,
      missing: missing.length,
      extra: extra.length,
      missingSample: missing.slice(0, 5),
    });
  }

  // Product selection membership is not visible in either count above.
  const assignments = readJson(path.join(inDir, '_product-selection-assignments.json'), []);
  const selectionRows = [];
  for (const a of assignments) {
    const sel = await target.byKey('/product-selections', a.productSelection.key);
    let count = 0;
    if (sel) {
      const res = await target.get(`/product-selections/${sel.id}/products`, { query: { limit: 0, withTotal: true } });
      count = res.total ?? 0;
    }
    selectionRows.push({ selection: a.productSelection.key, source: a.products.length, target: count });
  }

  const [srcProject, tgtProject] = await Promise.all([source.projectSettings(), target.projectSettings()]);
  const usage = readJson(path.join(inDir, '_usage.json'), { languages: [], countries: [], currencies: [] });
  const settingsGaps = [];
  for (const [field, want] of [
    ['languages', [...new Set([...(srcProject.languages || []), ...usage.languages])]],
    ['countries', [...new Set([...(srcProject.countries || []), ...usage.countries])]],
    ['currencies', [...new Set([...(srcProject.currencies || []), ...usage.currencies])]],
  ]) {
    const have = tgtProject[field] || [];
    const gap = want.filter((x) => !have.includes(x));
    if (gap.length) settingsGaps.push({ field, missing: gap });
  }

  const notCloned = readJson(path.join(inDir, '_not-cloned.json'), []) || NOT_CLONED.map((r) => ({ ...r, count: '?' }));

  return { rows, selectionRows, settingsGaps, notCloned, srcProject, tgtProject };
}

async function identities(client, r) {
  try {
    const set = new Set();
    for await (const e of client.paginate(r.path, { limit: 500 })) {
      const id = e.key || (r.naturalKey ? r.naturalKey(e) : null) || e.orderNumber || e.email || e.id;
      set.add(id);
    }
    return set;
  } catch (err) {
    if (err.status === 404 || err.status === 403) return null;
    throw err;
  }
}

export function renderVerify(result) {
  const { rows, selectionRows, settingsGaps, notCloned } = result;
  const lines = [];
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);

  lines.push('');
  lines.push(`${pad('resource', 24)}${padL('source', 8)}${padL('target', 8)}${padL('missing', 9)}${padL('extra', 7)}`);
  lines.push('-'.repeat(56));
  for (const r of rows) {
    lines.push(
      `${pad(r.resource, 24)}${padL(r.source, 8)}${padL(r.target, 8)}${padL(r.missing || '', 9)}${padL(r.extra || '', 7)}` +
        (r.missing ? `   e.g. ${r.missingSample.join(', ')}` : '')
    );
  }

  if (selectionRows.length) {
    lines.push('');
    lines.push('product selection membership');
    for (const s of selectionRows) {
      lines.push(`  ${pad(s.selection, 30)}${padL(s.source, 6)} -> ${padL(s.target, 6)}${s.source === s.target ? '' : '  MISMATCH'}`);
    }
  }

  if (settingsGaps.length) {
    lines.push('');
    lines.push('project settings gaps');
    for (const g of settingsGaps) lines.push(`  ${g.field}: missing ${g.missing.join(', ')}`);
  }

  lines.push('');
  lines.push('not cloned (by design)');
  for (const n of notCloned) {
    if (!n.count) continue;
    lines.push(`  ${pad(n.name, 20)}${padL(n.count, 5)} in source — ${n.why}`);
  }

  const totalMissing = rows.reduce((a, r) => a + r.missing, 0);
  lines.push('');
  lines.push(totalMissing ? `${totalMissing} entities missing in the target.` : 'Every keyed entity in the source is present in the target.');
  return lines.join('\n');
}
