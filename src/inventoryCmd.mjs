/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import { IN_ORDER, NOT_CLONED } from './resources.mjs';

/** A side-by-side count of every resource in both projects. */
export async function inventory(source, target) {
  const rows = [];
  const probe = async (client, r) => {
    try {
      const res = await client.get(r.path, { query: { limit: 0, withTotal: true } });
      return res.total ?? 0;
    } catch (err) {
      return err.status === 404 || err.status === 403 ? null : `err ${err.status}`;
    }
  };

  for (const r of [...IN_ORDER, ...NOT_CLONED]) {
    const [s, t] = await Promise.all([probe(source, r), probe(target, r)]);
    if (s === null && t === null) continue;
    rows.push({ resource: r.name, source: s ?? '-', target: t ?? '-', cloned: !NOT_CLONED.includes(r) });
  }

  const [sp, tp] = await Promise.all([source.projectSettings(), target.projectSettings()]);
  return { rows, source: sp, target: tp };
}

export function renderInventory({ rows, source, target }) {
  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);
  const out = [];
  out.push('');
  out.push(`source  ${source.key}  "${source.name}"`);
  out.push(`        languages ${(source.languages || []).join(', ')} | countries ${(source.countries || []).join(', ')} | currencies ${(source.currencies || []).join(', ')}`);
  out.push(`target  ${target.key}  "${target.name}"`);
  out.push(`        languages ${(target.languages || []).join(', ')} | countries ${(target.countries || []).join(', ')} | currencies ${(target.currencies || []).join(', ')}`);
  out.push('');
  out.push(`${pad('resource', 24)}${padL('source', 8)}${padL('target', 8)}   cloned`);
  out.push('-'.repeat(52));
  for (const r of rows) {
    out.push(`${pad(r.resource, 24)}${padL(r.source, 8)}${padL(r.target, 8)}   ${r.cloned ? 'yes' : 'no'}`);
  }
  return out.join('\n');
}
