/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RefIndex, rewriteRefs, strip, prune, hasUnresolved, dropUnresolved } from '../src/refs.mjs';
import { collectUsage, usageToArrays, newUsage } from '../src/locales.mjs';
import { buildAttributeTypeIndex, denormalizeAttributes } from '../src/attributes.mjs';
import { slugify, KEY_STRATEGIES } from '../src/keyfix.mjs';
import { BY_NAME } from '../src/resources.mjs';
import { buildOrderImportDraft } from '../src/orders.mjs';

test('strip removes generated fields and keeps the rest', () => {
  const out = strip({ id: 'x', version: 2, createdAt: 'now', key: 'k', name: 'n' });
  assert.deepEqual(out, { key: 'k', name: 'n' });
});

test('rewriteRefs turns ids into keys', () => {
  const index = new RefIndex();
  index.add('category', 'cat-id', 'cat-alpha');
  const out = rewriteRefs({ parent: { typeId: 'category', id: 'cat-id' } }, index);
  assert.deepEqual(out, { parent: { typeId: 'category', key: 'cat-alpha' } });
});

test('rewriteRefs flags a reference whose target has no key', () => {
  const index = new RefIndex();
  index.add('category', 'cat-id', null, 'Alpha');
  const unresolved = [];
  const out = rewriteRefs({ parent: { typeId: 'category', id: 'cat-id' } }, index, unresolved);
  assert.equal(out.parent.__unresolved, true);
  assert.equal(unresolved.length, 1);
  assert.equal(hasUnresolved(out), true);

  const dropped = [];
  assert.deepEqual(dropUnresolved(out, dropped), {});
  assert.deepEqual(dropped, ['category:cat-id']);
});

test('rewriteRefs drops expanded reference payloads', () => {
  const index = new RefIndex();
  index.add('product', 'p1', 'prod-a');
  const out = rewriteRefs({ product: { typeId: 'product', id: 'p1', obj: { huge: true } } }, index);
  assert.deepEqual(out, { product: { typeId: 'product', key: 'prod-a' } });
});

test('rewriteRefs leaves a plain object with an id alone', () => {
  const index = new RefIndex();
  const out = rewriteRefs({ address: { id: 'addr-1', city: 'Anytown' } }, index);
  assert.deepEqual(out, { address: { id: 'addr-1', city: 'Anytown' } });
});

test('collectUsage finds locales the project does not declare', () => {
  const usage = collectUsage({
    name: { 'en-US': 'Thing', 'en-CA': 'Thing', 'fr-CA': 'Chose' },
    masterVariant: { prices: [{ value: { currencyCode: 'CAD', centAmount: 1 }, country: 'CA' }] },
  });
  const out = usageToArrays(usage);
  assert.deepEqual(out.languages, ['en-CA', 'en-US', 'fr-CA']);
  assert.deepEqual(out.currencies, ['CAD']);
  assert.deepEqual(out.countries, ['CA']);
});

test('collectUsage does not mistake a reference for a localized string', () => {
  const out = usageToArrays(collectUsage({ name: { typeId: 'product', id: 'abc' } }));
  assert.deepEqual(out.languages, []);
});

test('enum attributes are written back as bare keys', () => {
  const index = buildAttributeTypeIndex([
    {
      key: 'widget',
      attributes: [
        { name: 'finish', type: { name: 'enum' } },
        { name: 'flags', type: { name: 'set', elementType: { name: 'lenum' } } },
        { name: 'organic', type: { name: 'boolean' } },
      ],
    },
  ]);
  const out = denormalizeAttributes(
    [
      { name: 'finish', value: { key: 'matte', label: 'Matte' } },
      { name: 'flags', value: [{ key: 'a', label: {} }, { key: 'b', label: {} }] },
      { name: 'organic', value: false },
    ],
    index.get('widget')
  );
  assert.deepEqual(out, [
    { name: 'finish', value: 'matte' },
    { name: 'flags', value: ['a', 'b'] },
    { name: 'organic', value: false },
  ]);
});

test('slugify produces a legal commercetools key', () => {
  assert.equal(slugify('Crème Brûlée — 8 pcs'), 'Creme-Brulee-8-pcs');
  assert.match(slugify('Naïve / Café — 2'), /^[A-Za-z0-9_-]+$/);
  assert.equal(slugify('', 'fallback'), 'fallback');
});

test('derived keys are stable across runs', () => {
  const product = {
    id: 'aaaa-bbbb-cccc-dddd',
    masterData: { current: { slug: { 'en-US': 'blue-widget-large' }, masterVariant: { sku: 'sku-1' } } },
  };
  assert.equal(KEY_STRATEGIES.products.derive(product), KEY_STRATEGIES.products.derive(product));
  assert.equal(KEY_STRATEGIES.products.derive(product), 'prod-blue-widget-large');
});

test('the customer draft converts default address ids into indices', () => {
  const draft = BY_NAME.customers.draft(
    {
      key: 'cust-a',
      email: 'a@b.ca',
      addresses: [{ id: 'X1', city: 'Anytown' }, { id: 'X2', city: 'Othertown' }],
      defaultShippingAddressId: 'X2',
      defaultBillingAddressId: 'X1',
      shippingAddressIds: ['X1', 'X2'],
      billingAddressIds: ['X1'],
      authenticationMode: 'Password',
    },
    { options: { customerPassword: 'pw' } }
  );
  assert.equal(draft.defaultShippingAddress, 1);
  assert.equal(draft.defaultBillingAddress, 0);
  assert.deepEqual(draft.shippingAddresses, [0, 1]);
  assert.equal(draft.password, 'pw');
  assert.equal(draft.addresses[0].id, undefined);
  assert.equal(draft.addresses[0].city, 'Anytown');
});

test('an externally authenticated customer gets no password', () => {
  const draft = BY_NAME.customers.draft(
    { key: 'c', email: 'a@b.ca', authenticationMode: 'ExternalAuth', addresses: [] },
    { options: { customerPassword: 'pw' } }
  );
  assert.equal(draft.password, undefined);
});

test('the product draft takes the staged projection when unpublished', () => {
  const ctx = { attributeTypeIndex: new Map() };
  const base = {
    key: 'p',
    productType: { typeId: 'product-type', key: 'pt' },
    masterData: {
      published: false,
      current: { name: { en: 'stale' }, slug: { en: 's' }, masterVariant: {} },
      staged: { name: { en: 'fresh' }, slug: { en: 's' }, masterVariant: { sku: 'sku1' } },
    },
  };
  const draft = BY_NAME.products.draft(base, ctx);
  assert.deepEqual(draft.name, { en: 'fresh' });
  assert.equal(draft.publish, false);

  base.masterData.published = true;
  assert.deepEqual(BY_NAME.products.draft(base, ctx).name, { en: 'stale' });
});

test('the product draft strips generated price fields', () => {
  const draft = BY_NAME.products.draft(
    {
      key: 'p',
      productType: { typeId: 'product-type', key: 'pt' },
      masterData: {
        published: true,
        current: {
          name: { en: 'n' },
          slug: { en: 's' },
          masterVariant: {
            id: 1,
            sku: 'sku1',
            prices: [
              {
                id: 'price-id',
                value: { currencyCode: 'CAD', centAmount: 100 },
                discounted: { value: {}, discount: {} },
                channel: { typeId: 'channel', key: 'ch' },
              },
            ],
          },
        },
      },
    },
    { attributeTypeIndex: new Map() }
  );
  const price = draft.masterVariant.prices[0];
  assert.equal(price.id, undefined);
  assert.equal(price.discounted, undefined);
  assert.deepEqual(price.channel, { typeId: 'channel', key: 'ch' });
  assert.equal(draft.masterVariant.id, undefined);
});

test('customer groups use groupName, which is what the draft calls it', () => {
  assert.deepEqual(BY_NAME['customer-groups'].draft({ key: 'k', name: 'Tier A', id: 'x', version: 1 }), {
    key: 'k',
    groupName: 'Tier A',
  });
});

test('tax rate ids are stripped so the target generates its own', () => {
  const draft = BY_NAME['tax-categories'].draft({
    key: 'tc',
    name: 'T',
    rates: [{ id: 'rate-id', name: 'Standard Rate', amount: 0.2, country: 'DE', includedInPrice: false }],
  });
  assert.equal(draft.rates[0].id, undefined);
  assert.equal(draft.rates[0].name, 'Standard Rate');
});

test('inventory identity falls back to sku plus supply channel', () => {
  assert.equal(
    BY_NAME.inventory.naturalKey({ sku: 'sku-1', supplyChannel: { typeId: 'channel', key: 'ch-1' } }),
    'sku-1::ch-1'
  );
});

test('the order import draft holds keys and reports what it cannot carry', () => {
  const ctx = {
    raw: new Map([
      ['products', [{ id: 'p1', key: 'prod-a' }]],
      ['customers', [{ id: 'c1', key: 'cust-a' }]],
    ]),
  };
  const draft = buildOrderImportDraft(
    {
      orderNumber: 'SO-1',
      key: 'ord-SO-1',
      customerId: 'c1',
      customerEmail: 'a@b.ca',
      totalPrice: { type: 'centPrecision', currencyCode: 'CAD', centAmount: 100, fractionDigits: 2 },
      lineItems: [
        { productId: 'p1', name: { en: 'x' }, quantity: 1, variant: { id: 1, sku: 's' }, price: { value: { currencyCode: 'CAD', centAmount: 100 } } },
      ],
      discountCodes: [{ discountCode: { typeId: 'discount-code', key: 'dc' } }],
      paymentInfo: { payments: [{ typeId: 'payment', key: 'pay-1' }] },
    },
    ctx
  );
  assert.deepEqual(draft.customer, { typeId: 'customer', key: 'cust-a' });
  assert.deepEqual(draft.lineItems[0].product, { typeId: 'product', key: 'prod-a' });
  assert.equal(draft.lineItems[0].productId, undefined);
  assert.deepEqual(draft._payments, [{ typeId: 'payment', key: 'pay-1' }]);
  assert.equal(draft._lossy.length, 1);
  assert.equal(draft._lossy[0].field, 'discountCodes');
});

test('prune drops nullish values but keeps false and zero', () => {
  assert.deepEqual(prune({ a: undefined, b: null, c: false, d: 0, e: '' }), { c: false, d: 0, e: '' });
});
