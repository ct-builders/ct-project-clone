/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Product attributes read back richer than they are written: an `enum` reads
 * as {key,label} but writes as the bare key, and a `set` of them reads as an
 * array of objects. Converting on export is what keeps a product draft
 * acceptable to the target.
 */

/** productTypeKey -> attributeName -> AttributeType */
export function buildAttributeTypeIndex(productTypes) {
  const index = new Map();
  for (const pt of productTypes) {
    const byName = new Map();
    for (const a of pt.attributes || []) byName.set(a.name, a.type);
    index.set(pt.key, byName);
  }
  return index;
}

export function denormalizeValue(type, value) {
  if (value === undefined || value === null) return value;
  switch (type?.name) {
    case 'enum':
    case 'lenum':
      return typeof value === 'object' && value !== null && 'key' in value ? value.key : value;
    case 'set':
      return Array.isArray(value) ? value.map((v) => denormalizeValue(type.elementType, v)) : value;
    case 'nested':
      // A nested attribute value is an array of {name, value} pairs; its own
      // types live on the referenced product type, resolved by the caller.
      return value;
    case 'reference':
      // Reference attributes take {typeId,id} only — never a key. Left as the
      // rewritten {typeId,key} here and resolved to a target id at import.
      return value;
    default:
      return value;
  }
}

/** Convert a read variant's `attributes` array into draft form. */
export function denormalizeAttributes(attributes, typeIndexForProductType, attrIndex, nestedResolver) {
  if (!Array.isArray(attributes)) return attributes;
  return attributes.map(({ name, value }) => {
    const type = typeIndexForProductType?.get(name);
    if (type?.name === 'nested' || (type?.name === 'set' && type.elementType?.name === 'nested')) {
      const nestedTypeRef = type.name === 'nested' ? type.typeReference : type.elementType.typeReference;
      const nestedTypes = nestedResolver ? nestedResolver(nestedTypeRef) : null;
      const one = (rows) =>
        Array.isArray(rows)
          ? denormalizeAttributes(rows, nestedTypes, attrIndex, nestedResolver)
          : rows;
      return { name, value: type.name === 'nested' ? one(value) : (value || []).map(one) };
    }
    return { name, value: denormalizeValue(type, value) };
  });
}

/** Walk a draft's attributes and swap {typeId,key} reference values for target ids. */
export async function resolveReferenceAttributes(value, resolveIdByKey) {
  if (Array.isArray(value)) {
    for (const v of value) await resolveReferenceAttributes(v, resolveIdByKey);
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  if (typeof value.typeId === 'string' && typeof value.key === 'string' && !('id' in value)) {
    const id = await resolveIdByKey(value.typeId, value.key);
    if (id) {
      delete value.key;
      value.id = id;
    }
    return value;
  }
  for (const v of Object.values(value)) await resolveReferenceAttributes(v, resolveIdByKey);
  return value;
}
