/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * A clone fails at the first write if the target project does not speak the
 * languages, countries and currencies the data is written in. These helpers
 * read those three sets out of the exported data itself rather than trusting
 * the source project's own settings, because the two drift: a project can
 * carry `en-CA` strings on its products while listing only `en-US` and
 * `fr-CA` as project languages.
 */

/** Field names that hold a LocalizedString in the commercetools model. */
const LOCALIZED_FIELDS = new Set([
  'name', 'description', 'slug', 'label', 'metaTitle', 'metaDescription',
  'metaKeywords', 'inputTip', 'localizedName', 'localizedDescription',
  'localizedMessage', 'title',
]);

const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?(-[A-Za-z0-9]{2,8})?$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

function looksLocalized(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (!keys.length) return false;
  return keys.every((k) => LOCALE_RE.test(k) && typeof v[k] === 'string');
}

/** Collect {languages, countries, currencies} actually used in a value tree. */
export function collectUsage(value, acc = { languages: new Set(), countries: new Set(), currencies: new Set() }) {
  (function walk(v, fieldName) {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, fieldName));
    if (!v || typeof v !== 'object') return;

    if ((LOCALIZED_FIELDS.has(fieldName) || fieldName === 'value') && looksLocalized(v)) {
      Object.keys(v).forEach((l) => acc.languages.add(l));
      return;
    }
    if (typeof v.currencyCode === 'string' && CURRENCY_RE.test(v.currencyCode)) {
      acc.currencies.add(v.currencyCode);
    }
    if (typeof v.country === 'string' && COUNTRY_RE.test(v.country)) {
      acc.countries.add(v.country);
    }
    if (typeof v.code === 'string' && COUNTRY_RE.test(v.code) && Object.keys(v).length <= 2) {
      acc.countries.add(v.code); // zone Location
    }
    for (const [k, child] of Object.entries(v)) walk(child, k);
  })(value, null);
  return acc;
}

export function usageToArrays(acc) {
  return {
    languages: [...acc.languages].sort(),
    countries: [...acc.countries].sort(),
    currencies: [...acc.currencies].sort(),
  };
}

export const newUsage = () => ({ languages: new Set(), countries: new Set(), currencies: new Set() });
