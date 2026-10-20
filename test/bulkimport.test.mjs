/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BULK_THRESHOLD, canBulkImport, bulkDecision, containerKey, bulkImport } from '../src/importApi.mjs';
import { importUrlFor } from '../src/config.mjs';
import { BY_NAME } from '../src/resources.mjs';
import { KEY_STRATEGIES, DEFAULT_KEYFIX } from '../src/keyfix.mjs';

test('the import host is the api host in the same region', () => {
  assert.equal(
    importUrlFor('https://api.us-central1.gcp.commercetools.com'),
    'https://import.us-central1.gcp.commercetools.com'
  );
  assert.equal(
    importUrlFor('https://api.europe-west1.gcp.commercetools.com'),
    'https://import.europe-west1.gcp.commercetools.com'
  );
  // Anything that is not the standard host is left alone rather than mangled.
  assert.equal(importUrlFor('https://ct-mock.internal'), 'https://ct-mock.internal');
});

test('only resources over the threshold take the bulk path', () => {
  const inventory = BY_NAME['inventory'];
  assert.equal(bulkDecision(inventory, BULK_THRESHOLD).bulk, false);
  assert.equal(bulkDecision(inventory, BULK_THRESHOLD + 1).bulk, true);
  assert.equal(bulkDecision(inventory, 96_783).bulk, true);
});

test('the threshold is overridable in both directions', () => {
  const inventory = BY_NAME['inventory'];
  assert.equal(bulkDecision(inventory, 100, 50).bulk, true);
  assert.equal(bulkDecision(inventory, 96_783, 1_000_000).bulk, false);
});

test('a large resource with no Import API mapping falls back and says so', () => {
  const orders = BY_NAME['orders'];
  assert.equal(canBulkImport(orders), false);
  const d = bulkDecision(orders, 20_000);
  assert.equal(d.bulk, false);
  assert.match(d.missed, /no Import API mapping/);
  assert.match(d.missed, /20000 entities/);
});

test('container keys are legal commercetools keys and unique per run', () => {
  const a = containerKey('inventory', Date.parse('2026-09-23T18:42:52.542Z'));
  assert.equal(a, 'ctclone-inventory-20260923184252');
  assert.match(a, /^[A-Za-z0-9_-]{2,256}$/);
  assert.notEqual(a, containerKey('inventory', Date.parse('2026-09-23T18:42:53.542Z')));
  assert.notEqual(a, containerKey('standalone-prices', Date.parse('2026-09-23T18:42:52.542Z')));
});

test('an inventory draft becomes an InventoryImport', () => {
  const { importApi } = BY_NAME['inventory'];
  const out = importApi.resource(
    {
      key: 'inv-ground-control-2bliss',
      sku: 'GC-2B-29',
      quantityOnStock: 15,
      restockableInDays: 2,
      supplyChannel: { typeId: 'channel', key: 'store-ret-brooklyn' },
    },
    'inv-ground-control-2bliss'
  );
  assert.deepEqual(out, {
    key: 'inv-ground-control-2bliss',
    sku: 'GC-2B-29',
    quantityOnStock: 15,
    restockableInDays: 2,
    supplyChannel: { typeId: 'channel', key: 'store-ret-brooklyn' },
  });
});

test('an unkeyed inventory draft borrows the identity keyfix derived', () => {
  const { importApi } = BY_NAME['inventory'];
  const out = importApi.resource({ sku: 'GC-2B-29', quantityOnStock: 0 }, 'inv-gc-2b-29');
  assert.equal(out.key, 'inv-gc-2b-29');
  // quantityOnStock is required by the Import API, so zero must survive.
  assert.equal(out.quantityOnStock, 0);
});

test('an inventory draft with nothing to key on is refused, not sent', () => {
  const { importApi } = BY_NAME['inventory'];
  assert.equal(importApi.resource({ sku: 'GC-2B-29', quantityOnStock: 1 }, null), null);
  assert.equal(importApi.resource({ quantityOnStock: 1 }, 'inv-x'), null);
});

test('inventory import carries no field the Import API does not define', () => {
  const { importApi } = BY_NAME['inventory'];
  const out = importApi.resource(
    { key: 'k', sku: 's', quantityOnStock: 1, availableQuantity: 99, id: 'x', version: 3 },
    'k'
  );
  assert.deepEqual(Object.keys(out).sort(), ['key', 'quantityOnStock', 'sku']);
});

test('discounts are keyfixed by default, from the field a human would recognise', () => {
  for (const name of ['cart-discounts', 'product-discounts', 'discount-codes']) {
    assert.ok(DEFAULT_KEYFIX.includes(name), `${name} should be keyfixed by default`);
    assert.ok(KEY_STRATEGIES[name], `${name} should have a key strategy`);
  }

  assert.equal(
    KEY_STRATEGIES['cart-discounts'].derive({ id: 'a1b2c3d4e5', name: { 'en-US': 'free shipping over $100' } }),
    'cd-free-shipping-over-100'
  );
  assert.equal(
    KEY_STRATEGIES['product-discounts'].derive({ id: 'a1b2c3d4e5', name: { 'en-US': 'Summer 20% off' } }),
    'pd-Summer-20-off'
  );
  // The code is what a shopper types and is unique; the name often is not.
  assert.equal(
    KEY_STRATEGIES['discount-codes'].derive({ id: 'a1b2c3d4e5', code: 'SCLUB-26-SHIP', name: { 'en-US': 'S-Club' } }),
    'dc-SCLUB-26-SHIP'
  );
});

test('a discount with no usable name still gets a stable key', () => {
  const e = { id: 'ffff1111-2222-3333-4444-5566778899aa', name: { 'en-US': '???' } };
  const first = KEY_STRATEGIES['cart-discounts'].derive(e);
  assert.equal(first, KEY_STRATEGIES['cart-discounts'].derive(e), 'derivation must be deterministic');
  assert.match(first, /^cd-[A-Za-z0-9_-]+$/);
});

test('every resource declaring an Import API mapping names a path and a type', () => {
  for (const [name, r] of Object.entries(BY_NAME)) {
    if (!r.importApi) continue;
    assert.equal(typeof r.importApi.path, 'string', `${name}: importApi.path`);
    assert.equal(typeof r.importApi.type, 'string', `${name}: importApi.type`);
    assert.equal(typeof r.importApi.resource, 'function', `${name}: importApi.resource`);
  }
});

/**
 * A stand-in for CtClient that records what the bulk path sends and hands
 * back the container summary a real run would converge on.
 */
function stubTarget({ settleAs = 'imported' } = {}) {
  const calls = { containers: [], batches: [], summaries: 0 };
  let settled = 0;
  return {
    label: 'target:test',
    concurrency: 6,
    importBase: 'https://import.us-central1.gcp.commercetools.com/test',
    calls,
    async post(url, body) {
      if (url.endsWith('/import-containers')) {
        calls.containers.push(body);
        return { key: body.key, version: 1 };
      }
      calls.batches.push({ url, body });
      settled += body.resources.length;
      return { operationStatus: [] };
    },
    async get(url) {
      if (url.includes('/import-summaries')) {
        calls.summaries++;
        return {
          states: {
            processing: 0,
            validationFailed: 0,
            unresolved: 0,
            waitForMasterVariant: 0,
            imported: 0,
            rejected: 0,
            [settleAs]: settled,
          },
        };
      }
      return { results: [] };
    },
    async mapLimit(items, fn) {
      for (const it of items) await fn(it);
    },
  };
}

const rows = (n) =>
  Array.from({ length: n }, (_, i) => ({
    _identity: `inv-sku-${i}`,
    draft: { key: `inv-sku-${i}`, sku: `SKU-${i}`, quantityOnStock: i },
  }));

test('bulk import batches 20 at a time against the inventories endpoint', async () => {
  const target = stubTarget();
  const ctx = { target, options: {}, warnings: [] };
  const stats = await bulkImport(ctx, BY_NAME['inventory'], rows(45));

  assert.equal(target.calls.containers.length, 1);
  assert.equal(target.calls.containers[0].resourceType, 'inventory');
  assert.match(target.calls.containers[0].key, /^ctclone-inventory-\d{14}$/);

  assert.equal(target.calls.batches.length, 3, '45 resources is 20 + 20 + 5');
  assert.deepEqual(target.calls.batches.map((b) => b.body.resources.length), [20, 20, 5]);
  for (const b of target.calls.batches) {
    assert.equal(b.body.type, 'inventory');
    assert.match(b.url, /\/inventories\/import-containers\/ctclone-inventory-/);
  }

  assert.equal(stats.created, 45);
  assert.equal(stats.failed, 0);
  assert.equal(stats.via, 'import-api');
});

test('bulk import reports rejected operations as failures, not successes', async () => {
  const target = stubTarget({ settleAs: 'rejected' });
  const ctx = { target, options: {}, warnings: [] };
  const stats = await bulkImport(ctx, BY_NAME['inventory'], rows(20));

  assert.equal(stats.created, 0);
  assert.equal(stats.failed, 20);
});

test('a row that cannot be shaped is skipped and warned about, not sent', async () => {
  const target = stubTarget();
  const ctx = { target, options: {}, warnings: [] };
  const bad = [{ _identity: 'inv-nosku', draft: { key: 'inv-nosku' } }];
  const stats = await bulkImport(ctx, BY_NAME['inventory'], [...rows(2), ...bad]);

  assert.equal(stats.skipped, 1);
  assert.equal(target.calls.batches[0].body.resources.length, 2, 'the unshapeable row is not sent');
  assert.match(ctx.warnings.join('\n'), /could not be shaped/);
});
