/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import { strip, prune } from './refs.mjs';

/**
 * Orders are the one resource with no create-from-draft endpoint that
 * round-trips: `POST /orders` needs a live cart. `POST /orders/import`
 * takes a finished order instead, which is what a clone needs.
 *
 * The import draft is narrower than an Order. What it cannot carry is listed
 * in ORDER_LOSSY and reported at the end of a run rather than dropped
 * silently.
 */

export const ORDER_LOSSY = [
  ['discountCodes', 'Applied discount codes are not part of the import draft; the order keeps its prices but loses the record of which code produced them.'],
  ['directDiscounts', 'Cart-level direct discounts are not importable.'],
  ['returnInfo', 'Returns are added after import through the Order Update API, not the import draft.'],
  ['syncInfo', 'Order export/sync markers belong to the source project.'],
  ['cart', 'The originating cart is not cloned, so the order arrives without a cart reference.'],
  ['discountOnTotalPrice', 'Recorded discount breakdown on the total is not part of the import draft.'],
];

/**
 * The Order Import API creates every order in External tax mode, whatever
 * the draft says — totals and taxed prices import exactly, but an order that
 * was Platform-taxed in the source arrives External. Reported per order
 * rather than sent, since sending it changes nothing.
 */
export const ORDER_TAX_MODE_NOTE =
  'taxMode: the Order Import API always creates External-taxed orders. Totals and per-line tax rates are preserved; the mode label is not.';

const money = (m) => (m ? prune({ type: m.type, currencyCode: m.currencyCode, centAmount: m.centAmount, fractionDigits: m.fractionDigits, preciseAmount: m.preciseAmount }) : undefined);

const taxedPrice = (tp) =>
  tp
    ? prune({
        totalNet: money(tp.totalNet),
        totalGross: money(tp.totalGross),
        totalTax: money(tp.totalTax),
        taxPortions: (tp.taxPortions || []).map((p) => prune({ name: p.name, rate: p.rate, amount: money(p.amount) })),
      })
    : undefined;

const taxRate = (tr) =>
  tr
    ? prune({
        name: tr.name,
        amount: tr.amount,
        includedInPrice: tr.includedInPrice,
        country: tr.country,
        state: tr.state,
        subRates: tr.subRates && tr.subRates.length ? tr.subRates : undefined,
        key: tr.key,
      })
    : undefined;

const price = (p) =>
  p
    ? prune({
        value: money(p.value),
        country: p.country,
        customerGroup: p.customerGroup,
        channel: p.channel,
        validFrom: p.validFrom,
        validUntil: p.validUntil,
        tiers: p.tiers && p.tiers.length ? p.tiers : undefined,
        custom: p.custom,
      })
    : undefined;

function lineItemDraft(li) {
  return prune({
    // Resolved to `productId` at import time, once the target id is known.
    product: li.productKey ? { typeId: 'product', key: li.productKey } : undefined,
    name: li.name,
    variant: prune({
      id: li.variant?.id,
      sku: li.variant?.sku,
      prices: (li.variant?.prices || []).map(price),
      attributes: li.variant?.attributes,
      images: li.variant?.images,
    }),
    price: price(li.price),
    quantity: li.quantity,
    state: (li.state || []).map((s) => prune({ quantity: s.quantity, state: s.state })),
    supplyChannel: li.supplyChannel,
    distributionChannel: li.distributionChannel,
    taxRate: taxRate(li.taxRate),
    taxedPrice: li.taxedPrice ? taxedPrice(li.taxedPrice) : undefined,
    shippingDetails: li.shippingDetails,
    custom: li.custom,
    priceMode: li.priceMode,
    inventoryMode: li.inventoryMode,
    perMethodTaxRate: li.perMethodTaxRate,
  });
}

function customLineItemDraft(cli) {
  return prune({
    name: cli.name,
    quantity: cli.quantity,
    money: money(cli.money),
    slug: cli.slug,
    state: (cli.state || []).map((s) => prune({ quantity: s.quantity, state: s.state })),
    taxRate: taxRate(cli.taxRate),
    taxedPrice: cli.taxedPrice ? taxedPrice(cli.taxedPrice) : undefined,
    taxCategory: cli.taxCategory,
    custom: cli.custom,
    shippingDetails: cli.shippingDetails,
    priceMode: cli.priceMode,
  });
}

function shippingInfoDraft(si) {
  if (!si) return undefined;
  return prune({
    shippingMethodName: si.shippingMethodName,
    price: money(si.price),
    shippingRate: si.shippingRate
      ? prune({
          price: money(si.shippingRate.price),
          freeAbove: money(si.shippingRate.freeAbove),
          tiers: si.shippingRate.tiers && si.shippingRate.tiers.length ? si.shippingRate.tiers : undefined,
        })
      : undefined,
    taxRate: taxRate(si.taxRate),
    taxCategory: si.taxCategory,
    shippingMethod: si.shippingMethod,
    deliveries: si.deliveries && si.deliveries.length ? si.deliveries.map((d) => strip(d)) : undefined,
    discountedPrice: si.discountedPrice,
    shippingMethodState: si.shippingMethodState,
    taxedPrice: si.taxedPrice ? taxedPrice(si.taxedPrice) : undefined,
  });
}

/**
 * Build an OrderImportDraft from an already ref-rewritten Order.
 * `customer` and each line item's `product` stay as key references here and
 * are converted to the ids the endpoint wants during import.
 */
export function buildOrderImportDraft(order, ctx) {
  const productKeyById = ctx.productKeyById || buildProductKeyIndex(ctx);
  const lineItems = (order.lineItems || []).map((li) =>
    lineItemDraft({ ...li, productKey: productKeyById.get(li.productId) || null })
  );

  const lossy = ORDER_LOSSY.filter(([field]) => {
    const v = order[field];
    return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null;
  }).map(([field, why]) => ({ field, why }));

  if (order.taxMode && order.taxMode !== 'External') {
    lossy.push({ field: 'taxMode', why: ORDER_TAX_MODE_NOTE, was: order.taxMode });
  }

  return prune({
    orderNumber: order.orderNumber,
    key: order.key,
    // Held as a key reference; swapped for `customerId` at import.
    customer: order.customerId
      ? { typeId: 'customer', key: (ctx.customerKeyById && ctx.customerKeyById.get(order.customerId)) || null }
      : undefined,
    customerEmail: order.customerEmail,
    lineItems,
    customLineItems: (order.customLineItems || []).map(customLineItemDraft),
    totalPrice: money(order.totalPrice),
    taxedPrice: taxedPrice(order.taxedPrice),
    shippingAddress: order.shippingAddress ? strip(order.shippingAddress) : undefined,
    billingAddress: order.billingAddress ? strip(order.billingAddress) : undefined,
    itemShippingAddresses: (order.itemShippingAddresses || []).map((a) => strip(a)),
    customerGroup: order.customerGroup,
    country: order.country,
    orderState: order.orderState,
    shipmentState: order.shipmentState,
    paymentState: order.paymentState,
    shippingInfo: shippingInfoDraft(order.shippingInfo),
    completedAt: order.completedAt,
    custom: order.custom,
    inventoryMode: order.inventoryMode,
    taxRoundingMode: order.taxRoundingMode,
    taxCalculationMode: order.taxCalculationMode,
    priceRoundingMode: order.priceRoundingMode,
    origin: order.origin,
    store: order.store,
    state: order.state,
    businessUnit: order.businessUnit,
    // Not part of the draft — attached with addPayment after the order lands.
    _payments: (order.paymentInfo?.payments || []).map((p) => p),
    _lossy: lossy.length ? lossy : undefined,
  });
}

function buildProductKeyIndex(ctx) {
  const map = new Map();
  for (const p of ctx.raw?.get('products') || []) if (p.key) map.set(p.id, p.key);
  ctx.productKeyById = map;
  const cmap = new Map();
  for (const c of ctx.raw?.get('customers') || []) if (c.key) cmap.set(c.id, c.key);
  ctx.customerKeyById = cmap;
  return map;
}
