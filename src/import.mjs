/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import path from 'node:path';
import { log } from './log.mjs';
import { HttpError } from './client.mjs';
import { IN_ORDER } from './resources.mjs';
import { dataDir, readJson } from './export.mjs';
import { dropUnresolved, hasUnresolved } from './refs.mjs';
import { resolveReferenceAttributes } from './attributes.mjs';
import { syncProjectSettings } from './project.mjs';
import { BULK_THRESHOLD, bulkDecision, bulkImport } from './importApi.mjs';

/**
 * Write the exported drafts into the target project.
 *
 * Import is idempotent by key: an entity whose key already exists in the
 * target is left alone. That makes a re-run safe after a partial failure and
 * makes "clone what is missing" the same command as "clone everything".
 */
export async function importProject(target, { sourceKey, only = null, dir = null, options = {} } = {}) {
  const inDir = dir || dataDir(sourceKey);
  const selected = IN_ORDER.filter((r) => !only || only.includes(r.name));

  const ctx = {
    target,
    options,
    inDir,
    idCache: new Map(), // `${typeId}:${key}` -> target id
    results: {},
    warnings: [],
  };

  // Languages, countries and currencies first: every later write is rejected
  // if the target does not speak them.
  if (!only || only.includes('_project')) {
    ctx.results._project = await syncProjectSettings(target, {
      settings: readJson(path.join(inDir, '_project.json')),
      usage: readJson(path.join(inDir, '_usage.json'), { languages: [], countries: [], currencies: [] }),
      options,
    });
  }

  for (const r of selected) {
    const drafts = readJson(path.join(inDir, `${r.name}.json`));
    if (!drafts) {
      log.skip(`${r.name}: nothing exported`);
      continue;
    }
    if (!drafts.length) {
      log.skip(`${r.name}: 0 in source`);
      ctx.results[r.name] = { total: 0, created: 0, existing: 0, failed: 0 };
      continue;
    }
    ctx.results[r.name] = await importResource(ctx, r, drafts);
  }

  // Passes that need two resources to already exist.
  if (!only || only.includes('states')) {
    ctx.results._state_transitions = await wireStateTransitions(ctx, readJson(path.join(inDir, 'states.json'), []));
  }
  if (!only || only.includes('product-selections')) {
    ctx.results._product_selection_assignments = await assignProductSelections(
      ctx,
      readJson(path.join(inDir, '_product-selection-assignments.json'), [])
    );
  }
  if (!only || only.includes('orders')) {
    ctx.results._order_payments = await attachOrderPayments(ctx, readJson(path.join(inDir, 'orders.json'), []));
  }

  return ctx;
}

/** Resolve a key to a target id, caching. Returns null when absent. */
async function targetId(ctx, typeId, key) {
  if (!key) return null;
  const cacheKey = `${typeId}:${key}`;
  if (ctx.idCache.has(cacheKey)) return ctx.idCache.get(cacheKey);
  const pathFor = PATH_BY_TYPE_ID[typeId];
  if (!pathFor) return null;
  const found = await ctx.target.byKey(pathFor, key);
  const id = found ? found.id : null;
  ctx.idCache.set(cacheKey, id);
  return id;
}

async function importResource(ctx, r, drafts) {
  const { target } = ctx;
  log.step(`${r.name} -> ${target.label} (${drafts.length})`);

  const stats = { total: drafts.length, created: 0, existing: 0, failed: 0, skipped: 0, errors: [] };

  // Pre-read what the target already has, so the common case costs one page
  // read rather than one lookup per entity.
  const existing = await existingIdentities(ctx, r);

  // Large resources go through the Import API, which takes 20 at a time
  // instead of one. What the target already holds is filtered out first, so
  // both routes leave an existing entity alone.
  const threshold = ctx.options.bulkThreshold ?? BULK_THRESHOLD;
  const toWrite = drafts.filter((row) => row._identity && !existing.has(row._identity));
  const decision = bulkDecision(r, toWrite.length, threshold);
  if (decision.missed) {
    log.info(`  ${decision.missed}`);
    ctx.warnings.push(decision.missed);
  }
  if (decision.bulk) {
    const unkeyed = drafts.filter((row) => !row._identity).length;
    const bulk = await bulkImport(ctx, r, toWrite.map((row) => withResolvedRefs(ctx, r, row)));
    bulk.total = drafts.length;
    bulk.existing = drafts.length - toWrite.length - unkeyed;
    bulk.skipped += unkeyed;
    if (unkeyed) {
      ctx.warnings.push(`${r.name}: an entity has no key and cannot be cloned idempotently — run keyfix on the source`);
    }
    const bits = [`${bulk.created} created`];
    if (bulk.existing) bits.push(`${bulk.existing} already there`);
    if (bulk.skipped) bits.push(`${bulk.skipped} skipped`);
    if (bulk.unresolved) bits.push(`${bulk.unresolved} unresolved`);
    if (bulk.failed) bits.push(`${bulk.failed} failed`);
    (bulk.failed ? log.warn : log.ok)(`  ${bits.join(', ')}`);
    return bulk;
  }

  const concurrency = r.heavy ? Math.min(target.concurrency, 6) : 4;
  const sequential = SEQUENTIAL.has(r.name);

  const work = async (row) => {
    const identity = row._identity;
    if (!identity) {
      stats.skipped++;
      ctx.warnings.push(`${r.name}: an entity has no key and cannot be cloned idempotently — run keyfix on the source`);
      return;
    }
    if (existing.has(identity)) {
      stats.existing++;
      return;
    }

    let draft = withResolvedRefs(ctx, r, row).draft;

    try {
      draft = await prepareDraft(ctx, r, draft);
      if (r.name === 'orders') await createOrder(ctx, draft);
      else await target.post(r.path, draft);
      stats.created++;
    } catch (err) {
      if (err instanceof HttpError && (err.has('DuplicateField') || err.has('DuplicateFieldWithConflictingResource'))) {
        stats.existing++;
        return;
      }
      stats.failed++;
      const message = err instanceof HttpError ? summarise(err) : err.message;
      if (stats.errors.length < 10) stats.errors.push({ identity, message });
      log.warn(`  ${r.name} ${identity}: ${message}`);
    }
  };

  if (sequential) for (const row of drafts) await work(row);
  else await target.mapLimit(drafts, work, concurrency);

  const bits = [`${stats.created} created`];
  if (stats.existing) bits.push(`${stats.existing} already there`);
  if (stats.skipped) bits.push(`${stats.skipped} skipped`);
  if (stats.failed) bits.push(`${stats.failed} failed`);
  (stats.failed ? log.warn : log.ok)(`  ${bits.join(', ')}`);
  return stats;
}

/**
 * A reference whose target has no key cannot be written either way, so it is
 * dropped and reported rather than sent. Both import routes go through this.
 */
function withResolvedRefs(ctx, r, row) {
  if (!hasUnresolved(row.draft)) return row;
  const dropped = [];
  const draft = dropUnresolved(row.draft, dropped);
  ctx.warnings.push(`${r.name} ${row._identity}: dropped reference(s) with no key on the other end — ${dropped.join(', ')}`);
  return { ...row, draft };
}

/** Resources whose creates must not race each other. */
const SEQUENTIAL = new Set(['categories', 'business-units']);

/** One read of the target's current identities for this resource. */
async function existingIdentities(ctx, r) {
  const set = new Set();
  try {
    for await (const e of ctx.target.paginate(r.path, { limit: 500 })) {
      const identity = e.key || (r.naturalKey ? r.naturalKey(e) : null);
      if (identity) set.add(identity);
      if (r.name === 'orders' && e.orderNumber) set.add(e.orderNumber);
      if (r.name === 'customers' && e.email) set.add(e.email.toLowerCase());
    }
  } catch (err) {
    if (err.status !== 404 && err.status !== 403) throw err;
  }
  return set;
}

/** Last-mile fixes that need the target to answer: key -> id, mostly. */
async function prepareDraft(ctx, r, draft) {
  const resolve = (typeId, key) => targetId(ctx, typeId, key);

  if (r.name === 'products') {
    // Reference-typed attributes take an id, never a key.
    for (const v of [draft.masterVariant, ...(draft.variants || [])]) {
      if (v?.attributes) await resolveReferenceAttributes(v.attributes, resolve);
    }
  }
  if (r.name === 'shopping-lists' && draft.customer?.key) {
    const id = await resolve('customer', draft.customer.key);
    draft = { ...draft, customer: id ? { typeId: 'customer', id } : undefined };
  }
  return draft;
}

/**
 * The import endpoint wants ids where the draft carries keys. Several fields
 * on an OrderImportDraft are plain References rather than ResourceIdentifiers
 * — `state` on the order and on each line item, and `customerGroup` — and a
 * key is rejected there with "Missing required value" on `id`.
 *
 * Rather than track which is which, every key reference in the body is
 * resolved to an id: a ResourceIdentifier accepts an id too, so this is
 * always correct.
 */
async function createOrder(ctx, draft) {
  const body = JSON.parse(JSON.stringify(draft));
  delete body._payments;
  delete body._lossy;

  if (body.customer?.key) {
    const id = await targetId(ctx, 'customer', body.customer.key);
    if (id) body.customerId = id;
  }
  delete body.customer;

  for (const li of body.lineItems || []) {
    if (li.product?.key) {
      const id = await targetId(ctx, 'product', li.product.key);
      if (id) li.productId = id;
    }
    delete li.product;
  }

  await keyRefsToIds(ctx, body, null);
  await ctx.target.post('/orders/import', body);
}

/**
 * Rewrite {typeId,key} into {typeId,id} in place.
 * `typeIds` limits which reference types are converted; null converts all.
 */
async function keyRefsToIds(ctx, value, typeIds) {
  if (Array.isArray(value)) {
    for (const v of value) await keyRefsToIds(ctx, v, typeIds);
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  if ((!typeIds || typeIds.has(value.typeId)) && typeof value.key === 'string' && !value.id) {
    const id = await targetId(ctx, value.typeId, value.key);
    if (id) {
      value.id = id;
      delete value.key;
    }
    return value;
  }
  for (const v of Object.values(value)) await keyRefsToIds(ctx, v, typeIds);
  return value;
}

/** States are created flat, then pointed at each other. */
async function wireStateTransitions(ctx, drafts) {
  const withTransitions = (drafts || []).filter((d) => d.draft?.transitions?.length || d.transitions?.length);
  if (!withTransitions.length) return { total: 0, updated: 0 };
  log.step(`state transitions (${withTransitions.length})`);
  let updated = 0;
  let failed = 0;
  for (const row of withTransitions) {
    const key = row._identity;
    const transitions = row.draft.transitions || row.transitions;
    try {
      const current = await ctx.target.byKey('/states', key);
      if (!current) continue;
      await ctx.target.post(`/states/key=${encodeURIComponent(key)}`, {
        version: current.version,
        actions: [{ action: 'setTransitions', transitions }],
      });
      updated++;
    } catch (err) {
      failed++;
      log.warn(`  state ${key}: ${err.message.slice(0, 200)}`);
    }
  }
  log.ok(`  ${updated} wired${failed ? `, ${failed} failed` : ''}`);
  return { total: withTransitions.length, updated, failed };
}

/** Product selection membership is its own endpoint on both sides. */
async function assignProductSelections(ctx, assignments) {
  const rows = (assignments || []).filter((a) => a.products.length);
  if (!rows.length) return { total: 0, assigned: 0 };
  const totalProducts = rows.reduce((n, a) => n + a.products.length, 0);
  log.step(`product selection assignments (${totalProducts} across ${rows.length} selections)`);

  let assigned = 0;
  let failed = 0;
  let already = 0;
  for (const row of rows) {
    const selKey = row.productSelection.key;
    const sel = await ctx.target.byKey('/product-selections', selKey);
    if (!sel) {
      log.warn(`  product selection ${selKey} missing in target`);
      continue;
    }

    const present = new Set();
    for await (const a of ctx.target.paginateOffset(`/product-selections/${sel.id}/products`, { limit: 500 })) {
      if (a.product?.id) present.add(a.product.id);
    }

    let version = sel.version;
    // Batched: one update request per 100 products keeps the version moving
    // forward once instead of per product.
    const wanted = row.products.filter((p) => p.product?.key);
    for (let i = 0; i < wanted.length; i += 100) {
      const slice = wanted.slice(i, i + 100);
      const actions = [];
      for (const p of slice) {
        const pid = await targetId(ctx, 'product', p.product.key);
        if (!pid) continue;
        if (present.has(pid)) { already++; continue; }
        actions.push({
          action: 'addProduct',
          product: { typeId: 'product', id: pid },
          ...(p.variantSelection ? { variantSelection: p.variantSelection } : {}),
          ...(p.variantExclusion ? { variantExclusion: p.variantExclusion } : {}),
        });
      }
      if (!actions.length) continue;
      try {
        const res = await ctx.target.post(`/product-selections/${sel.id}`, { version, actions });
        version = res.version;
        assigned += actions.length;
      } catch (err) {
        failed += actions.length;
        log.warn(`  ${selKey}: ${err.message.slice(0, 250)}`);
      }
    }
  }
  log.ok(`  ${assigned} assigned${already ? `, ${already} already there` : ''}${failed ? `, ${failed} failed` : ''}`);
  return { total: totalProducts, assigned, already, failed };
}

/** paymentInfo is not part of the order import draft; it is added after. */
async function attachOrderPayments(ctx, drafts) {
  const rows = (drafts || []).filter((d) => d.draft?._payments?.length);
  if (!rows.length) return { total: 0, attached: 0 };
  log.step(`order payments (${rows.length} orders)`);
  let attached = 0;
  let failed = 0;
  for (const row of rows) {
    const orderNumber = row.draft.orderNumber;
    try {
      const order = await ctx.target.get('/orders', { query: { where: `orderNumber="${orderNumber}"`, limit: 1 } });
      const found = order.results?.[0];
      if (!found) continue;
      const have = new Set((found.paymentInfo?.payments || []).map((p) => p.id));
      let version = found.version;
      for (const p of row.draft._payments) {
        const pid = p.key ? await targetId(ctx, 'payment', p.key) : null;
        if (!pid || have.has(pid)) continue;
        const res = await ctx.target.post(`/orders/${found.id}`, {
          version,
          actions: [{ action: 'addPayment', payment: { typeId: 'payment', id: pid } }],
        });
        version = res.version;
        attached++;
      }
    } catch (err) {
      failed++;
      log.warn(`  order ${orderNumber}: ${err.message.slice(0, 200)}`);
    }
  }
  log.ok(`  ${attached} payments attached${failed ? `, ${failed} failed` : ''}`);
  return { total: rows.length, attached, failed };
}

const PATH_BY_TYPE_ID = {
  product: '/products',
  'product-type': '/product-types',
  category: '/categories',
  channel: '/channels',
  customer: '/customers',
  'customer-group': '/customer-groups',
  state: '/states',
  store: '/stores',
  'tax-category': '/tax-categories',
  type: '/types',
  zone: '/zones',
  'shipping-method': '/shipping-methods',
  'product-selection': '/product-selections',
  'cart-discount': '/cart-discounts',
  'product-discount': '/product-discounts',
  'discount-code': '/discount-codes',
  'standalone-price': '/standalone-prices',
  'attribute-group': '/attribute-groups',
  'associate-role': '/associate-roles',
  'business-unit': '/business-units',
  'shopping-list': '/shopping-lists',
  payment: '/payments',
  order: '/orders',
  review: '/reviews',
  'inventory-entry': '/inventory',
};

/** Pull the useful sentence out of a commercetools error body. */
function summarise(err) {
  const errs = err.body?.errors;
  if (Array.isArray(errs) && errs.length) {
    // detailedErrorMessage names the offending field; message alone is often
    // just "Request body does not contain valid JSON."
    return errs
      .map((e) => `${e.code}: ${e.detailedErrorMessage || e.message}`)
      .join(' | ')
      .slice(0, 500);
  }
  return (err.body?.message || err.message || '').slice(0, 500);
}

export { targetId };
