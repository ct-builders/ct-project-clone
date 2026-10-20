/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import { log } from './log.mjs';

/**
 * Project settings come first because they gate everything else: a product
 * whose name is written in `en-CA` is rejected outright by a project that
 * does not list `en-CA`, and the same is true of every currency on a price
 * and every country on a tax rate.
 *
 * The source's own settings are not enough to go on: a project's declared
 * `languages` and the locales its data is actually written in drift apart,
 * so the target is widened to the union of what the source declares and what
 * the exported data actually uses.
 */

const union = (...lists) => [...new Set(lists.flat().filter(Boolean))];

export async function syncProjectSettings(target, { settings, usage, options = {} }) {
  if (!settings) {
    log.skip('project settings: nothing exported');
    return { skipped: true };
  }
  log.step(`project settings -> ${target.label}`);

  const current = await target.projectSettings();
  const actions = [];
  const notes = [];

  const wantLanguages = union(settings.languages, usage.languages);
  const wantCountries = union(settings.countries, usage.countries);
  const wantCurrencies = union(settings.currencies, usage.currencies);

  // Removing one of these fails whenever anything in the target still uses
  // it, so extras are kept unless explicitly pruned.
  const languages = options.pruneProjectSettings ? wantLanguages : union(current.languages, wantLanguages);
  const countries = options.pruneProjectSettings ? wantCountries : union(current.countries, wantCountries);
  const currencies = options.pruneProjectSettings ? wantCurrencies : union(current.currencies, wantCurrencies);

  const changed = (a, b) => a.length !== b.length || a.some((x) => !b.includes(x));

  if (changed(languages, current.languages || [])) actions.push({ action: 'changeLanguages', languages });
  if (changed(countries, current.countries || [])) actions.push({ action: 'changeCountries', countries });
  if (changed(currencies, current.currencies || [])) actions.push({ action: 'changeCurrencies', currencies });

  if (options.cloneProjectName && settings.name && settings.name !== current.name) {
    actions.push({ action: 'changeName', name: settings.name });
  }

  const srcMessages = settings.messages || {};
  const curMessages = current.messages || {};
  if (
    srcMessages.enabled !== undefined &&
    (srcMessages.enabled !== curMessages.enabled ||
      srcMessages.deleteDaysAfterCreation !== curMessages.deleteDaysAfterCreation)
  ) {
    actions.push({
      action: 'changeMessagesConfiguration',
      messagesConfiguration: {
        enabled: !!srcMessages.enabled,
        deleteDaysAfterCreation: srcMessages.deleteDaysAfterCreation ?? 15,
      },
    });
  }

  const srcCarts = settings.carts || {};
  const curCarts = current.carts || {};
  const cartKeys = [
    'deleteDaysAfterLastModification',
    'allowAddingUnpublishedProducts',
    'countryTaxRateFallbackEnabled',
    'priceRoundingMode',
    'taxRoundingMode',
  ];
  if (cartKeys.some((k) => srcCarts[k] !== undefined && srcCarts[k] !== curCarts[k])) {
    const cartsConfiguration = {};
    for (const k of cartKeys) if (srcCarts[k] !== undefined) cartsConfiguration[k] = srcCarts[k];
    actions.push({ action: 'changeCartsConfiguration', cartsConfiguration });
  }

  if (settings.shippingRateInputType && !current.shippingRateInputType) {
    actions.push({ action: 'setShippingRateInputType', shippingRateInputType: settings.shippingRateInputType });
  }

  // Search indexing is a separate action per index and takes time to build,
  // so it is requested and then left to run.
  const srcIndex = settings.searchIndexing || {};
  const curIndex = current.searchIndexing || {};
  const isOn = (s) => s?.status === 'Activated' || s?.status === 'Indexing';
  if (isOn(srcIndex.productsSearch) && !isOn(curIndex.productsSearch)) {
    actions.push({ action: 'changeProductSearchIndexingEnabled', enabled: true, mode: 'ProductsSearch' });
    notes.push('Product Search indexing requested — it builds in the background and the first queries return nothing until it finishes.');
  }
  if (isOn(srcIndex.products) && !isOn(curIndex.products)) {
    actions.push({ action: 'changeProductSearchIndexingEnabled', enabled: true, mode: 'ProductProjectionsSearch' });
  }
  if (isOn(srcIndex.orders) && !isOn(curIndex.orders)) {
    actions.push({ action: 'changeOrderSearchStatus', status: 'Activated' });
  }
  if (isOn(srcIndex.customers) && !isOn(curIndex.customers)) {
    actions.push({ action: 'changeCustomerSearchStatus', status: 'Activated' });
  }

  if (!actions.length) {
    log.skip('already matches');
    return { actions: 0, languages, countries, currencies, notes };
  }

  // One action at a time: if the target rejects one (a currency it cannot
  // drop, an index that is already building) the rest still land.
  let version = current.version;
  const applied = [];
  const rejected = [];
  for (const action of actions) {
    try {
      const res = await target.post('', { version, actions: [action] });
      version = res.version;
      applied.push(action.action);
    } catch (err) {
      rejected.push({ action: action.action, message: (err.body?.message || err.message || '').slice(0, 300) });
      log.warn(`  ${action.action} rejected: ${(err.body?.message || err.message || '').slice(0, 250)}`);
    }
  }

  log.ok(`${applied.length} applied${rejected.length ? `, ${rejected.length} rejected` : ''}`);
  log.ok(`languages ${languages.join(', ')} | countries ${countries.join(', ')} | currencies ${currencies.join(', ')}`);
  for (const n of notes) log.info(`  ${n}`);

  return { actions: applied.length, applied, rejected, languages, countries, currencies, notes };
}
