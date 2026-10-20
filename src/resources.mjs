/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import { strip, prune } from './refs.mjs';
import { denormalizeAttributes } from './attributes.mjs';

const stripAddress = (a) => (a ? strip(a, []) : a);
const stripAddresses = (arr) => (Array.isArray(arr) ? arr.map(stripAddress) : arr);

/** Turn `defaultShippingAddressId` and friends into the index form a draft wants. */
function addressIndices(entity) {
  const ids = (entity.addresses || []).map((a) => a.id);
  const idx = (id) => {
    const i = ids.indexOf(id);
    return i === -1 ? undefined : i;
  };
  return {
    defaultShippingAddress: idx(entity.defaultShippingAddressId),
    defaultBillingAddress: idx(entity.defaultBillingAddressId),
    shippingAddresses: (entity.shippingAddressIds || []).map(idx).filter((i) => i !== undefined),
    billingAddresses: (entity.billingAddressIds || []).map(idx).filter((i) => i !== undefined),
  };
}

function variantDraft(v, attrTypes, ctx) {
  return prune({
    sku: v.sku,
    key: v.key,
    prices: (v.prices || []).map((p) =>
      prune({
        key: p.key,
        value: p.value,
        country: p.country,
        customerGroup: p.customerGroup,
        channel: p.channel,
        validFrom: p.validFrom,
        validUntil: p.validUntil,
        tiers: p.tiers && p.tiers.length ? p.tiers : undefined,
        custom: p.custom,
        recurrencePolicy: p.recurrencePolicy,
      })
    ),
    images: v.images,
    assets: (v.assets || []).map((a) => strip(a)),
    attributes: denormalizeAttributes(v.attributes, attrTypes, null, (ref) =>
      ctx.attributeTypeIndex ? ctx.attributeTypeIndex.get(ref && ref.key) : undefined
    ),
  });
}

/**
 * The clone order. `order` is the only thing that sequences the run — a
 * resource may only reference resources with a lower number.
 */
export const RESOURCES = [
  {
    name: 'types',
    path: '/types',
    order: 10,
    draft: (e) => strip(e),
  },
  {
    name: 'tax-categories',
    path: '/tax-categories',
    order: 20,
    draft: (e) => ({ ...strip(e), rates: (e.rates || []).map((r) => strip(r)) }),
  },
  {
    name: 'zones',
    path: '/zones',
    order: 30,
    draft: (e) => strip(e),
  },
  {
    name: 'customer-groups',
    path: '/customer-groups',
    order: 40,
    // CustomerGroupDraft names the field `groupName`, not `name`.
    draft: (e) => prune({ key: e.key, groupName: e.name, custom: e.custom }),
  },
  {
    name: 'states',
    path: '/states',
    order: 50,
    // Transitions point at other states, which may not exist yet. Created
    // flat, then wired up in the transitions pass.
    draft: (e) => strip(e, ['transitions', 'builtIn']),
    deferredFields: ['transitions'],
  },
  {
    name: 'channels',
    path: '/channels',
    order: 60,
    draft: (e) => ({ ...strip(e, ['reviewRatingStatistics']), address: stripAddress(e.address) }),
  },
  {
    name: 'product-types',
    path: '/product-types',
    order: 70,
    draft: (e) => strip(e),
  },
  {
    name: 'categories',
    path: '/categories',
    order: 80,
    // Parents must exist first, so shallow categories are written first.
    sortExport: (a, b) => (a.ancestors ? a.ancestors.length : 0) - (b.ancestors ? b.ancestors.length : 0),
    draft: (e) => ({
      ...strip(e, ['ancestors', 'stores']),
      assets: (e.assets || []).map((a) => strip(a)),
    }),
  },
  {
    name: 'product-selections',
    path: '/product-selections',
    order: 90,
    draft: (e) => strip(e, ['productCount', 'type']),
  },
  {
    name: 'stores',
    path: '/stores',
    order: 100,
    draft: (e) => ({
      ...strip(e, ['productSelections']),
      productSelections: (e.productSelections || []).map((ps) => ({
        productSelection: ps.productSelection,
        active: ps.active,
      })),
    }),
  },
  {
    name: 'shipping-methods',
    path: '/shipping-methods',
    order: 110,
    draft: (e) => strip(e, ['references']),
  },
  {
    name: 'products',
    path: '/products',
    order: 120,
    heavy: true,
    draft: (e, ctx) => {
      const published = !!(e.masterData && e.masterData.published);
      const d = published ? e.masterData.current : e.masterData.staged;
      if (!d) return null;
      const ptKey = e.productType && e.productType.key;
      const attrTypes = ctx.attributeTypeIndex ? ctx.attributeTypeIndex.get(ptKey) : undefined;
      return prune({
        key: e.key,
        productType: e.productType,
        name: d.name,
        slug: d.slug,
        description: d.description,
        categories: d.categories,
        categoryOrderHints: d.categoryOrderHints,
        metaTitle: d.metaTitle,
        metaDescription: d.metaDescription,
        metaKeywords: d.metaKeywords,
        masterVariant: variantDraft(d.masterVariant, attrTypes, ctx),
        variants: (d.variants || []).map((v) => variantDraft(v, attrTypes, ctx)),
        taxCategory: e.taxCategory,
        searchKeywords:
          d.searchKeywords && Object.keys(d.searchKeywords).length ? d.searchKeywords : undefined,
        state: e.state,
        priceMode: e.priceMode,
        publish: published,
      });
    },
  },
  {
    name: 'standalone-prices',
    path: '/standalone-prices',
    order: 130,
    draft: (e) => strip(e, ['discounted', 'staged']),
    // StandalonePriceImport is the draft plus a required key. `discounted`
    // and `staged` are already stripped, and both are platform-derived.
    importApi: {
      path: 'standalone-prices',
      type: 'standalone-price',
      resource: (d, identity) => (identity ? { ...d, key: d.key || identity } : null),
    },
  },
  {
    name: 'inventory',
    path: '/inventory',
    order: 140,
    heavy: true,
    // sku + supply channel is the uniqueness constraint the API enforces, so
    // it works as an identity even where no key has been set.
    naturalKey: (e) => `${e.sku}::${(e.supplyChannel && (e.supplyChannel.key || e.supplyChannel.id)) || ''}`,
    draft: (e) => strip(e, ['availableQuantity']),
    // InventoryImport carries exactly the draft's fields under different
    // optionality: `key` and `quantityOnStock` are required, `supplyChannel`
    // is a ChannelKeyReference — which is the shape the export already
    // rewrote every reference into. There is no `key` on the HTTP draft for
    // an unkeyed entity, so identity supplies it; keyfix means it is there.
    importApi: {
      path: 'inventories',
      type: 'inventory',
      resource: (d, identity) => {
        const key = d.key || identity;
        if (!key || !d.sku) return null;
        return prune({
          key,
          sku: d.sku,
          quantityOnStock: d.quantityOnStock ?? 0,
          restockableInDays: d.restockableInDays,
          expectedDelivery: d.expectedDelivery,
          reservationExpirationInMinutes: d.reservationExpirationInMinutes,
          supplyChannel: d.supplyChannel,
          custom: d.custom,
        });
      },
    },
  },
  {
    name: 'product-discounts',
    path: '/product-discounts',
    order: 150,
    draft: (e) => strip(e, ['references']),
  },
  {
    name: 'cart-discounts',
    path: '/cart-discounts',
    order: 160,
    draft: (e) => strip(e, ['references']),
  },
  {
    name: 'discount-codes',
    path: '/discount-codes',
    order: 170,
    draft: (e) => strip(e, ['references', 'applicationVersion']),
  },
  {
    name: 'attribute-groups',
    path: '/attribute-groups',
    order: 180,
    draft: (e) => strip(e),
  },
  {
    name: 'associate-roles',
    path: '/associate-roles',
    order: 190,
    draft: (e) => strip(e),
  },
  {
    name: 'customers',
    path: '/customers',
    order: 200,
    naturalKey: (e) => e.key || (e.email || '').toLowerCase(),
    lookupBy: 'email',
    draft: (e, ctx) =>
      prune({
        ...strip(e, [
          'password',
          'addresses',
          'defaultShippingAddressId',
          'defaultBillingAddressId',
          'shippingAddressIds',
          'billingAddressIds',
          'customerGroupAssignments',
        ]),
        addresses: stripAddresses(e.addresses),
        ...addressIndices(e),
        customerGroupAssignments:
          e.customerGroupAssignments && e.customerGroupAssignments.length
            ? e.customerGroupAssignments
            : undefined,
        password:
          e.authenticationMode === 'ExternalAuth' ? undefined : ctx.options.customerPassword,
      }),
  },
  {
    name: 'business-units',
    path: '/business-units',
    order: 210,
    sortExport: (a, b) => (a.parentUnit ? 1 : 0) - (b.parentUnit ? 1 : 0),
    draft: (e) => ({
      ...strip(e, [
        'addresses',
        'topLevelUnit',
        'ancestors',
        'inheritedAssociates',
        'inheritedStores',
        'inheritedApprovalRuleMode',
      ]),
      addresses: stripAddresses(e.addresses),
      ...addressIndices(e),
    }),
  },
  {
    name: 'shopping-lists',
    path: '/shopping-lists',
    order: 220,
    draft: (e) => ({
      ...strip(e, ['lineItems', 'textLineItems']),
      lineItems: (e.lineItems || []).map((li) =>
        prune({
          key: li.key,
          sku: li.variant && li.variant.sku ? li.variant.sku : undefined,
          productId: li.variant && li.variant.sku ? undefined : li.productId,
          variantId: li.variant && li.variant.sku ? undefined : li.variantId,
          quantity: li.quantity,
          addedAt: li.addedAt,
          custom: li.custom,
        })
      ),
      textLineItems: (e.textLineItems || []).map((t) => strip(t)),
    }),
  },
  {
    name: 'custom-objects',
    path: '/custom-objects',
    order: 230,
    naturalKey: (e) => `${e.container}/${e.key}`,
    draft: (e) => ({ container: e.container, key: e.key, value: e.value }),
  },
  {
    name: 'reviews',
    path: '/reviews',
    order: 240,
    draft: (e) => strip(e, ['includedInStatistics']),
  },
  {
    name: 'payments',
    path: '/payments',
    order: 250,
    draft: (e) => ({
      ...strip(e, ['transactions', 'interfaceInteractions']),
      transactions: (e.transactions || []).map((t) => strip(t)),
      interfaceInteractions:
        e.interfaceInteractions && e.interfaceInteractions.length
          ? e.interfaceInteractions
          : undefined,
    }),
  },
  // Orders go through the Order Import API, not POST /orders. The draft is
  // built in src/orders.mjs and the importer special-cases this name.
  {
    name: 'orders',
    path: '/orders',
    order: 260,
    naturalKey: (e) => e.key || e.orderNumber,
    lookupBy: 'orderNumber',
    heavy: true,
    draft: null,
  },
];

/** Resources that exist but are deliberately not cloned, and why. */
export const NOT_CLONED = [
  {
    name: 'carts',
    path: '/carts',
    why: 'Session state. The storefront recreates carts on demand; cloning them resurrects abandoned carts against customers whose ids have changed.',
  },
  {
    name: 'quotes',
    path: '/quotes',
    why: 'No import endpoint — a quote is the end of a request/staged-quote chain that only a live cart can start.',
  },
  {
    name: 'quote-requests',
    path: '/quote-requests',
    why: 'No import endpoint.',
  },
  {
    name: 'staged-quotes',
    path: '/staged-quotes',
    why: 'No import endpoint.',
  },
  {
    name: 'api-clients',
    path: '/api-clients',
    why: 'A client secret is returned exactly once, at creation. Existing secrets are unrecoverable, so clients are reported and re-minted by hand.',
  },
  {
    name: 'extensions',
    path: '/extensions',
    why: 'Carries an external URL and its auth header, which the API redacts on read. Reported so it can be re-pointed by hand.',
  },
  {
    name: 'subscriptions',
    path: '/subscriptions',
    why: 'Carries message-queue credentials, which the API redacts on read. Reported so it can be re-pointed by hand.',
  },
  {
    name: 'product-tailoring',
    path: '/product-tailoring',
    why: 'Store-scoped product overrides. Reported; not yet rebuilt.',
  },
];

export const BY_NAME = Object.fromEntries(RESOURCES.map((r) => [r.name, r]));
export const IN_ORDER = [...RESOURCES].sort((a, b) => a.order - b.order);
