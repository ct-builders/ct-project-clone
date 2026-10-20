/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import { log } from './log.mjs';
import { HttpError } from './client.mjs';

/**
 * The only write this toolkit makes to the source project: a `key` on
 * entities that have none. A key is the one handle that means the same thing
 * in both projects, so an entity without one cannot be cloned idempotently —
 * a re-run would create a second copy rather than recognise the first.
 *
 * Every key here is derived deterministically from data already on the
 * entity, so running this twice produces the same keys, and a key that
 * already exists is never overwritten.
 */

const MAX_KEY = 256;

/** commercetools keys allow [A-Za-z0-9_-] only, 2..256 chars. */
export function slugify(input, fallback) {
  const base = String(input ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  const out = base || String(fallback ?? '');
  return out.slice(0, MAX_KEY);
}

const firstLocale = (loc) => {
  if (!loc || typeof loc !== 'object') return '';
  return loc['en-US'] || loc['en'] || Object.values(loc)[0] || '';
};

/** Short, stable suffix so two entities with the same name never collide. */
const tail = (id) => String(id || '').replace(/-/g, '').slice(-8);

export const KEY_STRATEGIES = {
  products: {
    path: '/products',
    describe: 'products',
    derive: (e) => {
      const slug = firstLocale(e.masterData?.current?.slug) || firstLocale(e.masterData?.staged?.slug);
      const name = firstLocale(e.masterData?.current?.name) || firstLocale(e.masterData?.staged?.name);
      const sku = e.masterData?.current?.masterVariant?.sku || e.masterData?.staged?.masterVariant?.sku;
      const base = slugify(slug || sku || name, '');
      return base ? `prod-${base}`.slice(0, MAX_KEY) : `prod-${tail(e.id)}`;
    },
  },
  customers: {
    path: '/customers',
    describe: 'customers',
    derive: (e) => {
      const base = slugify((e.email || '').split('@')[0], '');
      return base ? `cust-${base}`.slice(0, MAX_KEY) : `cust-${tail(e.id)}`;
    },
  },
  inventory: {
    path: '/inventory',
    describe: 'inventory entries',
    // sku + supply channel is already the uniqueness constraint; the key just
    // makes it addressable.
    derive: (e, ctx) => {
      const ch = e.supplyChannel?.id ? ctx.channelKeyById.get(e.supplyChannel.id) : null;
      const base = slugify(e.sku, tail(e.id));
      return `inv-${base}${ch ? `--${slugify(ch, '')}` : ''}`.slice(0, MAX_KEY);
    },
  },
  'shopping-lists': {
    path: '/shopping-lists',
    describe: 'shopping lists',
    derive: (e) => {
      const base = slugify(firstLocale(e.name), '');
      return base ? `sl-${base}-${tail(e.id)}` : `sl-${tail(e.id)}`;
    },
  },
  payments: {
    path: '/payments',
    describe: 'payments',
    derive: (e) => {
      const base = slugify(e.interfaceId || e.paymentMethodInfo?.method, '');
      return base ? `pay-${base}-${tail(e.id)}` : `pay-${tail(e.id)}`;
    },
  },
  'cart-discounts': {
    path: '/cart-discounts',
    describe: 'cart discounts',
    derive: (e) => {
      const base = slugify(firstLocale(e.name), '');
      return base ? `cd-${base}`.slice(0, MAX_KEY) : `cd-${tail(e.id)}`;
    },
  },
  'product-discounts': {
    path: '/product-discounts',
    describe: 'product discounts',
    derive: (e) => {
      const base = slugify(firstLocale(e.name), '');
      return base ? `pd-${base}`.slice(0, MAX_KEY) : `pd-${tail(e.id)}`;
    },
  },
  'discount-codes': {
    path: '/discount-codes',
    describe: 'discount codes',
    // `code` is what a shopper types and is unique per project, so it is a
    // better key than the name — two codes often share a campaign name.
    derive: (e) => {
      const base = slugify(e.code || firstLocale(e.name), '');
      return base ? `dc-${base}`.slice(0, MAX_KEY) : `dc-${tail(e.id)}`;
    },
  },
  // Kept available for `--only orders`, but not run by default: the platform
  // rejects `setKey` on an Order with "Invalid type value 'setKey'" even
  // though the OpenAPI spec lists the action. Orders do not need it —
  // `orderNumber` is already unique per project and is what the clone
  // matches on.
  orders: {
    path: '/orders',
    describe: 'orders',
    derive: (e) => {
      const base = slugify(e.orderNumber, '');
      return base ? `ord-${base}`.slice(0, MAX_KEY) : `ord-${tail(e.id)}`;
    },
  },
};

export const DEFAULT_KEYFIX = [
  'products',
  'customers',
  'shopping-lists',
  'payments',
  'cart-discounts',
  'product-discounts',
  'discount-codes',
  'inventory',
];

async function channelKeyIndex(client) {
  const map = new Map();
  for await (const ch of client.paginate('/channels', { limit: 500 })) map.set(ch.id, ch.key);
  return map;
}

/**
 * Add keys to source entities that lack them.
 * Returns a per-resource summary: {scanned, missing, added, collisions, failed}.
 */
export async function keyfix(client, { only = DEFAULT_KEYFIX, dryRun = false, concurrency = 8 } = {}) {
  const ctx = { channelKeyById: await channelKeyIndex(client) };
  const summary = {};

  for (const name of only) {
    const strategy = KEY_STRATEGIES[name];
    if (!strategy) {
      log.warn(`  no key strategy for "${name}" — skipped`);
      continue;
    }
    log.step(`keyfix ${strategy.describe} in ${client.label}`);

    const missing = [];
    const taken = new Set();
    let scanned = 0;
    for await (const e of client.paginate(strategy.path, { limit: 500 })) {
      scanned++;
      if (e.key) taken.add(e.key);
      else missing.push(e);
    }

    if (!missing.length) {
      log.skip(`${scanned} ${strategy.describe}, all keyed`);
      summary[name] = { scanned, missing: 0, added: 0, collisions: 0, failed: 0 };
      continue;
    }

    // Resolve derived-key collisions up front so the writes can run in parallel.
    const planned = [];
    let collisions = 0;
    for (const e of missing) {
      let key = strategy.derive(e, ctx);
      if (taken.has(key)) {
        collisions++;
        let n = 2;
        while (taken.has(`${key}-${n}`)) n++;
        key = `${key}-${n}`;
      }
      taken.add(key);
      planned.push({ entity: e, key });
    }

    if (dryRun) {
      log.info(
        `  would add ${planned.length} keys, e.g. ` +
          planned.slice(0, 3).map((p) => p.key).join(', ')
      );
      summary[name] = { scanned, missing: missing.length, added: 0, collisions, failed: 0, dryRun: true };
      continue;
    }

    let added = 0;
    let failed = 0;
    await client.mapLimit(
      planned,
      async ({ entity, key }) => {
        try {
          await client.post(`${strategy.path}/${entity.id}`, {
            version: entity.version,
            actions: [{ action: 'setKey', key }],
          });
          added++;
        } catch (err) {
          if (err instanceof HttpError && err.has('DuplicateField')) {
            // Another run got there first; the entity is keyed either way.
            added++;
            return;
          }
          failed++;
          log.warn(`  setKey failed on ${name} ${entity.id}: ${err.message.slice(0, 200)}`);
        }
      },
      concurrency
    );

    log.ok(`${added}/${planned.length} keys added${collisions ? `, ${collisions} name collisions disambiguated` : ''}${failed ? `, ${failed} failed` : ''}`);
    summary[name] = { scanned, missing: missing.length, added, collisions, failed };
  }

  return summary;
}
