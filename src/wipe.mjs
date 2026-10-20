/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import { log } from './log.mjs';
import { IN_ORDER } from './resources.mjs';

/**
 * Empty the target so a clone can be re-run from scratch.
 *
 * Deletion runs in reverse dependency order, and repeats until a pass
 * deletes nothing new — a category with children and a product still in a
 * selection both refuse the first attempt and succeed on a later one.
 *
 * This deletes data. It requires the target project key to be typed back.
 */
export async function wipe(target, { confirmProjectKey, only = null, keepProducts = false } = {}) {
  if (confirmProjectKey !== target.projectKey) {
    throw new Error(
      `wipe needs --confirm ${target.projectKey} to proceed (got ${confirmProjectKey || 'nothing'}).`
    );
  }

  const order = [...IN_ORDER].reverse().filter((r) => {
    if (only && !only.includes(r.name)) return false;
    if (keepProducts && r.name === 'products') return false;
    return true;
  });

  const totals = {};
  for (let pass = 1; pass <= 3; pass++) {
    let deletedThisPass = 0;
    for (const r of order) {
      const items = await safeAll(target, r);
      if (!items.length) continue;

      let deleted = 0;
      let blocked = 0;
      await target.mapLimit(
        items,
        async (e) => {
          try {
            const query = r.name === 'orders' || r.name === 'payments' ? { dataErasure: true } : undefined;
            await target.del(`${r.path}/${e.id}`, { query: { version: e.version, ...(query || {}) } });
            deleted++;
          } catch (err) {
            if (err.status === 404) return;
            blocked++;
          }
        },
        6
      );
      deletedThisPass += deleted;
      totals[r.name] = (totals[r.name] || 0) + deleted;
      if (deleted || blocked) {
        log.info(`  pass ${pass} ${r.name}: ${deleted} deleted${blocked ? `, ${blocked} still referenced` : ''}`);
      }
    }
    if (!deletedThisPass) break;
  }

  const remaining = {};
  for (const r of order) {
    const n = await safeCount(target, r);
    if (n) remaining[r.name] = n;
  }
  return { deleted: totals, remaining };
}

async function safeAll(client, r) {
  try {
    return await client.all(r.path, { limit: 500 });
  } catch (err) {
    if (err.status === 404 || err.status === 403) return [];
    throw err;
  }
}

async function safeCount(client, r) {
  try {
    return await client.count(r.path);
  } catch {
    return 0;
  }
}
