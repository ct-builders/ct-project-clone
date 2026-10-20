/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import { log } from './log.mjs';
import { HttpError } from './client.mjs';

/**
 * Bulk writes go through the Import API rather than one POST per entity.
 *
 * The HTTP API takes one request per entity, which is the right shape for a
 * few hundred and the wrong shape for a hundred thousand: a catalogue's
 * inventory alone runs to six figures, and at one request each the run is
 * measured in hours. The Import API takes 20 resources per request and
 * processes them asynchronously, so the same data costs a twentieth of the
 * requests.
 *
 * It is not a drop-in replacement, which is why this is opt-in per resource:
 *
 *   - Import resources are their own types. They are close to the HTTP
 *     drafts but not identical, so each resource that wants this path
 *     declares an `importApi` descriptor in resources.mjs saying how to
 *     shape one. A resource without a descriptor keeps the per-entity path
 *     however large it is.
 *   - A 201 means "accepted", not "written". The work is tracked as
 *     ImportOperations and has to be polled to completion.
 *   - It upserts by key, where the per-entity path leaves an existing
 *     entity alone. The caller filters out what the target already has
 *     before calling in, which keeps re-run behaviour the same either way.
 */

/** Above this many entities to write, a resource that can bulk-import does. */
export const BULK_THRESHOLD = 5000;

/** The Import API takes at most this many resources in one request. */
const BATCH = 20;

/** Give up waiting for a container to drain after this long. */
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True if this resource knows how to shape itself for the Import API. */
export function canBulkImport(r) {
  return Boolean(r && r.importApi);
}

/**
 * Whether a resource of this size should take the bulk path, and why not if
 * it should not. Returned rather than logged so the caller can report a
 * large resource that had to fall back.
 */
export function bulkDecision(r, count, threshold = BULK_THRESHOLD) {
  if (count <= threshold) return { bulk: false };
  if (!canBulkImport(r)) {
    return { bulk: false, missed: `${r.name}: ${count} entities, but no Import API mapping — using one request per entity` };
  }
  return { bulk: true };
}

/**
 * A container key is scoped to one run of one resource so its summary counts
 * only this run's work. Keys are limited to [A-Za-z0-9_-].
 */
export function containerKey(resourceName, now = Date.now()) {
  const stamp = new Date(now).toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  return `ctclone-${resourceName}-${stamp}`.slice(0, 256);
}

/**
 * Write `rows` through the Import API. Returns the same stats shape as the
 * per-entity path so the report does not care which route a resource took.
 */
export async function bulkImport(ctx, r, rows) {
  const { target } = ctx;
  const { path: resourcePath, type, resource: toResource } = r.importApi;
  const stats = { total: rows.length, created: 0, existing: 0, failed: 0, skipped: 0, errors: [], via: 'import-api' };

  const key = containerKey(r.name);
  log.info(`  via Import API — container ${key}, ${Math.ceil(rows.length / BATCH)} requests of up to ${BATCH}`);

  await target.post(`${target.importBase}/import-containers`, { key, resourceType: type });

  // Shape first so a mapping bug fails before anything is sent.
  const resources = [];
  for (const row of rows) {
    const shaped = toResource(row.draft, row._identity);
    if (!shaped) {
      stats.skipped++;
      ctx.warnings.push(`${r.name} ${row._identity}: could not be shaped for the Import API`);
      continue;
    }
    resources.push(shaped);
  }

  const batches = [];
  for (let i = 0; i < resources.length; i += BATCH) batches.push(resources.slice(i, i + BATCH));

  let sent = 0;
  await target.mapLimit(
    batches,
    async (batch) => {
      try {
        await target.post(`${target.importBase}/${resourcePath}/import-containers/${key}`, { type, resources: batch });
        sent += batch.length;
      } catch (err) {
        stats.failed += batch.length;
        const message = err instanceof HttpError ? `${err.status} ${JSON.stringify(err.body).slice(0, 200)}` : err.message;
        if (stats.errors.length < 10) stats.errors.push({ identity: batch[0]?.key, message });
        log.warn(`  ${r.name}: a batch of ${batch.length} was rejected on submit — ${message}`);
      }
    },
    Math.min(target.concurrency, 6)
  );

  if (!sent) {
    log.warn(`  0 accepted, ${stats.failed} rejected on submit`);
    return stats;
  }

  const states = await awaitContainer(target, key, sent);
  stats.created = states.imported;
  stats.failed += states.rejected + states.validationFailed;
  stats.unresolved = states.unresolved;

  if (states.rejected || states.validationFailed || states.unresolved) {
    for (const op of await failedOperations(target, key)) {
      if (stats.errors.length >= 10) break;
      stats.errors.push({ identity: op.resourceKey, message: op.message });
      log.warn(`  ${r.name} ${op.resourceKey}: ${op.message}`);
    }
  }
  return stats;
}

/**
 * Poll the container summary until nothing is in flight. `unresolved` counts
 * as settled: it means a KeyReference the import needs is absent from the
 * target, and nothing this run does later will supply it.
 */
async function awaitContainer(target, key, expected) {
  const started = Date.now();
  let wait = 1000;
  let last = null;

  for (;;) {
    const summary = await target.get(`${target.importBase}/import-containers/${key}/import-summaries`);
    const s = { processing: 0, validationFailed: 0, unresolved: 0, waitForMasterVariant: 0, imported: 0, rejected: 0, ...(summary.states || {}) };
    const inFlight = s.processing + s.waitForMasterVariant;
    const settled = s.imported + s.rejected + s.validationFailed + s.unresolved;

    if (settled !== last) {
      log.debug(`  ${key}: ${settled}/${expected} settled (${s.imported} imported, ${inFlight} in flight)`);
      last = settled;
    }

    if (inFlight === 0 && settled >= expected) return s;

    if (Date.now() - started > POLL_TIMEOUT_MS) {
      log.warn(`  ${key}: still ${inFlight} in flight after ${Math.round(POLL_TIMEOUT_MS / 60000)}m — reporting what has settled`);
      return s;
    }
    await sleep(wait);
    wait = Math.min(wait * 1.5, 10_000);
  }
}

/** A bounded sample of what did not import, for the run report. */
async function failedOperations(target, key, limit = 10) {
  const out = [];
  for (const state of ['rejected', 'validationFailed', 'unresolved']) {
    if (out.length >= limit) break;
    try {
      const page = await target.get(`${target.importBase}/import-containers/${key}/import-operations`, {
        query: { limit: limit - out.length, state },
      });
      for (const op of page.results || []) {
        const why =
          (op.errors || []).map((e) => e.message || e.code).join('; ') ||
          (op.unresolvedReferences || []).map((u) => `unresolved ${u.typeId}:${u.key}`).join('; ') ||
          op.state;
        out.push({ resourceKey: op.resourceKey, message: `${op.state} — ${why}`.slice(0, 250) });
      }
    } catch {
      // Detail is a nicety; the counts in the summary are the report.
    }
  }
  return out;
}
