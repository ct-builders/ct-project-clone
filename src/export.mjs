/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { log } from './log.mjs';
import { RefIndex, rewriteRefs, strip, collectUnresolved } from './refs.mjs';
import { collectUsage, newUsage, usageToArrays } from './locales.mjs';
import { buildAttributeTypeIndex } from './attributes.mjs';
import { IN_ORDER, NOT_CLONED } from './resources.mjs';
import { buildOrderImportDraft } from './orders.mjs';

export function dataDir(projectKey) {
  return path.join(ROOT, 'data', projectKey);
}

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};

export const readJson = (file, fallback = null) =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;

/**
 * Read everything out of the source project and write it to disk as drafts
 * that reference other entities by key rather than by id.
 *
 * Export is a read-only pass over the source. It runs in two sweeps: the
 * first builds the id -> key index across every resource, the second shapes
 * drafts, because a reference can point forward as easily as backward.
 */
export async function exportProject(client, { only = null, dir = null, options = {} } = {}) {
  const outDir = dir || dataDir(client.projectKey);
  fs.mkdirSync(outDir, { recursive: true });

  const selected = IN_ORDER.filter((r) => !only || only.includes(r.name));
  const index = new RefIndex();
  const raw = new Map();
  const usage = newUsage();
  const report = { projectKey: client.projectKey, exportedAt: new Date().toISOString(), resources: {} };

  log.step(`export ${client.label} -> ${path.relative(ROOT, outDir)}/`);

  // Sweep 1 — read everything, index every id against its key.
  for (const r of selected) {
    let items;
    try {
      items = await client.all(r.path, { limit: r.heavy ? 200 : 500 });
    } catch (err) {
      if (err.status === 404 || err.status === 403) {
        log.skip(`${r.name}: not available on this project (${err.status})`);
        report.resources[r.name] = { exported: 0, unavailable: true, status: err.status };
        continue;
      }
      throw err;
    }
    if (r.sortExport) items.sort(r.sortExport);
    raw.set(r.name, items);

    const refTypeId = REF_TYPE_BY_RESOURCE[r.name];
    for (const e of items) {
      const key = e.key || (r.naturalKey ? r.naturalKey(e) : null);
      if (refTypeId) index.add(refTypeId, e.id, e.key || null, labelOf(r.name, e));
      if (r.name === 'customers') index.add('customer', e.id, e.key || null, e.email);
    }
    log.ok(`${r.name}: ${items.length} read`);
  }

  // Product attribute types drive enum denormalisation on variants.
  const attributeTypeIndex = buildAttributeTypeIndex(raw.get('product-types') || []);
  const ctx = { attributeTypeIndex, index, options, raw };

  // Sweep 2 — shape drafts with references rewritten to keys.
  const unresolvedAll = [];
  for (const r of selected) {
    const items = raw.get(r.name);
    if (!items) continue;

    const drafts = [];
    const noKey = [];
    for (const e of items) {
      const identity = e.key || (r.naturalKey ? r.naturalKey(e) : null);
      if (!identity) noKey.push(e.id);

      const rewritten = rewriteRefs(e, index);
      let draft;
      if (r.name === 'orders') {
        draft = buildOrderImportDraft(rewritten, ctx);
      } else {
        draft = r.draft ? r.draft(rewritten, ctx) : strip(rewritten);
      }
      if (!draft) continue;

      collectUsage(draft, usage);
      // Only references that survive into the draft matter — an order's
      // `cart` reference is dangling but the import draft has no such field.
      const unresolved = collectUnresolved(draft);
      if (unresolved.length) {
        unresolvedAll.push({ resource: r.name, identity, refs: unresolved });
      }
      drafts.push({ _identity: identity, _sourceId: e.id, draft });
    }

    writeJson(path.join(outDir, `${r.name}.json`), drafts);
    report.resources[r.name] = {
      exported: drafts.length,
      read: items.length,
      withoutIdentity: noKey.length,
    };
    if (noKey.length) {
      log.warn(`  ${r.name}: ${noKey.length} without a key — run keyfix on the source first`);
    }
  }

  // Cross-cutting extras.
  const settings = await client.projectSettings();
  writeJson(path.join(outDir, '_project.json'), strip(settings, ['trialUntil', 'ownerId']));

  const selections = await exportProductSelectionAssignments(client, raw, index);
  writeJson(path.join(outDir, '_product-selection-assignments.json'), selections);
  report.productSelectionAssignments = selections.reduce((n, s) => n + s.products.length, 0);

  const reportedOnly = await probeNotCloned(client);
  writeJson(path.join(outDir, '_not-cloned.json'), reportedOnly);
  report.notCloned = reportedOnly;

  const discovered = usageToArrays(usage);
  writeJson(path.join(outDir, '_usage.json'), discovered);
  report.usage = discovered;
  report.unresolvedReferences = unresolvedAll;

  writeJson(path.join(outDir, '_index.json'), index.toJSON());
  writeJson(path.join(outDir, '_export-report.json'), report);

  log.ok(
    `export complete — languages in data: ${discovered.languages.join(', ')} | ` +
      `currencies: ${discovered.currencies.join(', ')} | countries: ${discovered.countries.join(', ')}`
  );
  if (unresolvedAll.length) {
    log.warn(`  ${unresolvedAll.length} entities carry a reference with no key on the other end`);
  }
  return report;
}

/** Product selection membership lives on its own endpoint, not on either side. */
async function exportProductSelectionAssignments(client, raw, index) {
  const out = [];
  for (const sel of raw.get('product-selections') || []) {
    const products = [];
    for await (const a of client.paginateOffset(`/product-selections/${sel.id}/products`, { limit: 500 })) {
      const hit = index.get(a.product?.id);
      products.push({
        product: hit?.key ? { typeId: 'product', key: hit.key } : { typeId: 'product', id: a.product?.id, __unresolved: true },
        variantSelection: a.variantSelection,
        variantExclusion: a.variantExclusion,
      });
    }
    out.push({ productSelection: { typeId: 'product-selection', key: sel.key }, products });
  }
  return out;
}

/** Count and describe what is deliberately left behind. */
async function probeNotCloned(client) {
  const out = [];
  for (const r of NOT_CLONED) {
    let count = null;
    let detail = [];
    try {
      const res = await client.get(r.path, { query: { limit: r.name === 'api-clients' ? 100 : 0, withTotal: true } });
      count = res.total ?? (res.results ? res.results.length : 0);
      if (r.name === 'api-clients') {
        detail = (res.results || []).map((c) => ({ id: c.id, name: c.name, scope: c.scope }));
      }
      if (r.name === 'extensions' || r.name === 'subscriptions') {
        const full = await client.get(r.path, { query: { limit: 100 } });
        detail = (full.results || []).map((x) => ({
          key: x.key,
          destination: x.destination?.type,
          triggers: x.triggers || x.messages,
        }));
      }
    } catch (err) {
      count = `unavailable (${err.status})`;
    }
    out.push({ ...r, count, detail });
  }
  return out;
}

/** The reference typeId a resource is pointed at by. */
const REF_TYPE_BY_RESOURCE = {
  types: 'type',
  'tax-categories': 'tax-category',
  zones: 'zone',
  'customer-groups': 'customer-group',
  states: 'state',
  channels: 'channel',
  'product-types': 'product-type',
  categories: 'category',
  'product-selections': 'product-selection',
  stores: 'store',
  'shipping-methods': 'shipping-method',
  products: 'product',
  'standalone-prices': 'standalone-price',
  inventory: 'inventory-entry',
  'product-discounts': 'product-discount',
  'cart-discounts': 'cart-discount',
  'discount-codes': 'discount-code',
  'attribute-groups': 'attribute-group',
  'associate-roles': 'associate-role',
  customers: 'customer',
  'business-units': 'business-unit',
  'shopping-lists': 'shopping-list',
  reviews: 'review',
  payments: 'payment',
  orders: 'order',
};

function labelOf(resourceName, e) {
  if (e.email) return e.email;
  if (e.orderNumber) return e.orderNumber;
  if (e.sku) return e.sku;
  if (typeof e.name === 'string') return e.name;
  if (e.name && typeof e.name === 'object') return Object.values(e.name)[0];
  return `${resourceName}:${e.id}`;
}
