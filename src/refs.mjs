/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Cross-project cloning turns on one idea: commercetools ids are project-local,
 * but keys are not. Everything here converts id-shaped references into
 * key-shaped ResourceIdentifiers on export, so the target API resolves them
 * itself on import — no id translation table at write time.
 */

/** Fields the API generates. Never send them back. */
export const READONLY = [
  'id',
  'version',
  'versionModifiedAt',
  'createdAt',
  'lastModifiedAt',
  'createdBy',
  'lastModifiedBy',
  'lastMessageSequenceNumber',
  'lastVariantId',
  'obj',
];

const REF_TYPE_IDS = new Set([
  'cart', 'cart-discount', 'category', 'channel', 'customer', 'customer-group',
  'discount-code', 'inventory-entry', 'key-value-document', 'order', 'payment',
  'product', 'product-discount', 'product-price', 'product-selection',
  'product-type', 'review', 'shipping-method', 'shopping-list', 'state',
  'store', 'tax-category', 'type', 'zone', 'quote', 'quote-request',
  'staged-quote', 'business-unit', 'associate-role', 'standalone-price',
  'attribute-group', 'direct-discount', 'discount-group', 'recurring-order',
  'recurrence-policy', 'order-edit', 'extension', 'subscription',
]);

export function isReference(v) {
  return (
    v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof v.typeId === 'string' &&
    REF_TYPE_IDS.has(v.typeId) &&
    (typeof v.id === 'string' || typeof v.key === 'string')
  );
}

/** Drop read-only fields from a shallow copy. */
export function strip(obj, extra = []) {
  const out = {};
  const drop = new Set([...READONLY, ...extra]);
  for (const [k, v] of Object.entries(obj)) if (!drop.has(k)) out[k] = v;
  return out;
}

/** Remove undefined/null and empty arrays that the API would reject or ignore. */
export function prune(value) {
  if (Array.isArray(value)) return value.map(prune).filter((v) => v !== undefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const p = prune(v);
      if (p !== undefined && p !== null) out[k] = p;
    }
    return out;
  }
  return value;
}

/**
 * An index of every source id we have seen, and the key it maps to.
 * Built during export; serialized alongside the data so import can explain
 * what a dangling reference pointed at.
 */
export class RefIndex {
  constructor(entries = {}) {
    this.byId = new Map(Object.entries(entries));
  }
  add(typeId, id, key, label) {
    if (!id) return;
    this.byId.set(id, { typeId, key: key ?? null, label: label ?? null });
  }
  get(id) {
    return this.byId.get(id) || null;
  }
  toJSON() {
    return Object.fromEntries(this.byId);
  }
  static fromJSON(o) {
    return new RefIndex(o || {});
  }
}

/**
 * Walk a value, rewriting every {typeId,id} reference to {typeId,key}.
 * Unresolvable references are tagged so the importer can report them
 * instead of sending an id that means something else in the target.
 */
export function rewriteRefs(value, index, unresolved = []) {
  if (Array.isArray(value)) return value.map((v) => rewriteRefs(v, index, unresolved));
  if (!value || typeof value !== 'object') return value;

  if (isReference(value)) {
    if (value.key) return { typeId: value.typeId, key: value.key };
    const hit = index.get(value.id);
    if (hit && hit.key) return { typeId: value.typeId, key: hit.key };
    unresolved.push({ typeId: value.typeId, id: value.id, label: hit?.label ?? null });
    return { typeId: value.typeId, id: value.id, __unresolved: true };
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === 'obj') continue; // expanded reference payload
    out[k] = rewriteRefs(v, index, unresolved);
  }
  return out;
}

/** Every unresolved reference that survived into a finished draft. */
export function collectUnresolved(value, out = []) {
  if (Array.isArray(value)) {
    value.forEach((v) => collectUnresolved(v, out));
    return out;
  }
  if (value && typeof value === 'object') {
    if (value.__unresolved) {
      out.push({ typeId: value.typeId, id: value.id });
      return out;
    }
    Object.values(value).forEach((v) => collectUnresolved(v, out));
  }
  return out;
}

/** True if any reference under `value` failed to resolve to a key. */
export function hasUnresolved(value) {
  let found = false;
  (function walk(v) {
    if (found) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      if (v.__unresolved) { found = true; return; }
      Object.values(v).forEach(walk);
    }
  })(value);
  return found;
}

/** Strip references that never resolved, so the rest of the draft can still land. */
export function dropUnresolved(value, dropped = []) {
  if (Array.isArray(value)) {
    return value
      .map((v) => dropUnresolved(v, dropped))
      .filter((v) => v !== undefined);
  }
  if (value && typeof value === 'object') {
    if (value.__unresolved) {
      dropped.push(`${value.typeId}:${value.id}`);
      return undefined;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const d = dropUnresolved(v, dropped);
      if (d !== undefined) out[k] = d;
    }
    return out;
  }
  return value;
}
