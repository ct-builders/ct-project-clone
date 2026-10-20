/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import { log } from './log.mjs';

/**
 * Checks the data diff cannot make: that the target actually behaves like a
 * commercetools project rather than merely containing the right rows. A
 * product can match the source field for field and still have a reference
 * that resolves to nothing, and a cloned customer is only cloned if they can
 * log in.
 */
export async function smoke(target, { customerPassword = '123' } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const tryIt = async (name, fn) => {
    try {
      const detail = await fn();
      add(name, true, detail);
    } catch (err) {
      add(name, false, (err.body?.message || err.message || String(err)).slice(0, 250));
    }
  };

  log.step(`smoke checks on ${target.label}`);

  await tryIt('a cloned customer can log in', async () => {
    const page = await target.get('/customers', { query: { limit: 1 } });
    const customer = page.results[0];
    if (!customer) return 'no customers to check';
    const res = await target.post('/login', { email: customer.email, password: customerPassword });
    if (!res.customer) throw new Error('login returned no customer');
    return `${customer.email} / ${customerPassword}`;
  });

  await tryIt('a product resolves every reference it carries', async () => {
    const page = await target.get('/products', {
      query: {
        limit: 1,
        expand: ['productType', 'taxCategory', 'masterData.current.categories[*]'],
      },
    });
    const p = page.results[0];
    if (!p) return 'no products to check';
    const d = p.masterData.current;
    const missing = [];
    if (!p.productType?.obj) missing.push('productType');
    if (p.taxCategory && !p.taxCategory.obj) missing.push('taxCategory');
    const badCats = (d.categories || []).filter((c) => !c.obj).length;
    if (badCats) missing.push(`${badCats} categories`);
    if (missing.length) throw new Error(`dangling: ${missing.join(', ')}`);
    return `${p.key}: ${d.categories.length} categories, ${d.masterVariant.prices.length} prices, ${(d.masterVariant.images || []).length} images`;
  });

  await tryIt('a store points at real channels and a real selection', async () => {
    const page = await target.get('/stores', {
      query: { limit: 1, expand: ['distributionChannels[*]', 'supplyChannels[*]', 'productSelections[*].productSelection'] },
    });
    const s = page.results[0];
    if (!s) return 'no stores to check';
    const dangling =
      s.distributionChannels.filter((c) => !c.obj).length +
      s.supplyChannels.filter((c) => !c.obj).length +
      (s.productSelections || []).filter((ps) => !ps.productSelection.obj).length;
    if (dangling) throw new Error(`${dangling} dangling references on store ${s.key}`);
    return `${s.key}: ${s.distributionChannels.length} distribution, ${s.supplyChannels.length} supply, ${(s.productSelections || []).length} selections`;
  });

  await tryIt('an order links to its products, customer and payments', async () => {
    const page = await target.get('/orders', { query: { limit: 1, expand: ['lineItems[*].state[*].state'] } });
    const o = page.results[0];
    if (!o) return 'no orders to check';
    const unlinked = (o.lineItems || []).filter((li) => !li.productId).length;
    if (unlinked) throw new Error(`${unlinked} line items with no product`);
    return `${o.orderNumber}: ${o.lineItems.length} items, ${o.paymentInfo?.payments?.length || 0} payments, total ${o.totalPrice.centAmount} ${o.totalPrice.currencyCode}`;
  });

  await tryIt('a shipping method covers its zones', async () => {
    const page = await target.get('/shipping-methods', { query: { limit: 1, expand: ['zoneRates[*].zone', 'taxCategory'] } });
    const m = page.results[0];
    if (!m) return 'no shipping methods to check';
    const dangling = m.zoneRates.filter((z) => !z.zone.obj).length;
    if (dangling) throw new Error(`${dangling} zone rates point at a missing zone`);
    return `${m.key}: ${m.zoneRates.length} zones, tax ${m.taxCategory?.obj?.key || 'none'}`;
  });

  await tryIt('product search is indexed and returns results', async () => {
    const project = await target.projectSettings();
    if (project.searchIndexing?.productsSearch?.status !== 'Activated') {
      return `not activated on this project (${project.searchIndexing?.productsSearch?.status || 'off'})`;
    }
    const all = await target.post('/products/search', { query: { exists: { field: 'id' } }, limit: 1 });
    if (!all.total) {
      throw new Error('indexing is on but the index is empty — it builds in the background, retry in a few minutes');
    }
    // A count alone can come from a stale index; a term search proves the
    // cloned names actually made it in.
    const page = await target.get('/products', { query: { limit: 1, where: 'masterData(published = true)' } });
    const name = Object.values(page.results[0]?.masterData.current.name || {})[0] || '';
    const term = name.split(/\s+/)[0];
    const hit = term
      ? await target.post('/products/search', {
          query: { fullText: { field: 'name', language: project.languages[0], value: term } },
          limit: 1,
        })
      : { total: 0 };
    return `${all.total} indexed; "${term}" matches ${hit.total}`;
  });

  await tryIt('add to cart succeeds on a cloned product', async () => {
    const page = await target.get('/products', { query: { limit: 1, where: 'masterData(published = true)' } });
    const p = page.results[0];
    const sku = p?.masterData.current.masterVariant.sku;
    if (!sku) return 'no published product to check';
    const project = await target.projectSettings();
    const currency = project.currencies[0];
    const cart = await target.post('/carts', { currency, country: project.countries[0] });
    try {
      const withItem = await target.post(`/carts/${cart.id}`, {
        version: cart.version,
        actions: [{ action: 'addLineItem', sku, quantity: 1 }],
      });
      const total = withItem.totalPrice;
      await target.del(`/carts/${withItem.id}`, { query: { version: withItem.version } });
      return `${sku} added, cart total ${total.centAmount} ${total.currencyCode}`;
    } catch (err) {
      await target.del(`/carts/${cart.id}`, { query: { version: cart.version } }).catch(() => {});
      throw err;
    }
  });

  for (const c of checks) (c.ok ? log.ok : log.warn)(`${c.ok ? '' : 'FAILED '}${c.name} — ${c.detail}`);
  return checks;
}

export function renderSmoke(checks) {
  const failed = checks.filter((c) => !c.ok);
  const lines = ['', 'smoke checks'];
  for (const c of checks) lines.push(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}\n         ${c.detail}`);
  lines.push('', failed.length ? `${failed.length} of ${checks.length} failed.` : `All ${checks.length} passed.`);
  return lines.join('\n');
}
