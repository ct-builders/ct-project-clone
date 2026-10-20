/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSelection, loadConfigFile, SELECTABLE, PROJECT_SETTINGS, CONFIG_FILE } from '../src/selection.mjs';
import { ROOT, ConfigError } from '../src/config.mjs';
import { RESOURCES, NOT_CLONED } from '../src/resources.mjs';

/** A config file in a scratch directory, removed when the process exits. */
function configFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctclone-sel-'));
  const file = path.join(dir, 'ctclone.config.json');
  fs.writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return file;
}

// Reads the repo root, where a developer may legitimately keep their own
// selection. Skipped rather than failed in that case — the same guarantee is
// covered without ambient state by 'a config file with no resources key'.
test('nothing configured resolves to null, so every stage keeps its own defaults', (t) => {
  if (fs.existsSync(path.join(ROOT, CONFIG_FILE))) {
    t.skip(`${CONFIG_FILE} exists in the repo root`);
    return;
  }
  const { names, from } = resolveSelection({ configPath: null, only: null, exclude: null });
  assert.equal(names, null);
  assert.equal(from, 'default');
});

test('--only selects exactly what it names, in dependency order', () => {
  const { names, from } = resolveSelection({ only: ['products', 'types'] });
  assert.deepEqual(names, ['types', 'products']);
  assert.equal(from, 'flag');
});

test('--only does not drag in project settings', () => {
  const { names } = resolveSelection({ only: ['products'] });
  assert.equal(names.includes(PROJECT_SETTINGS), false);
});

test('--exclude keeps everything else, project settings included', () => {
  const { names } = resolveSelection({ exclude: ['orders'] });
  assert.equal(names.includes('orders'), false);
  assert.equal(names.includes(PROJECT_SETTINGS), true);
  assert.equal(names.length, SELECTABLE.length - 1);
});

test('--only and --exclude together is refused', () => {
  assert.throws(() => resolveSelection({ only: ['products'], exclude: ['orders'] }), ConfigError);
});

test('an unknown resource name stops the run instead of selecting nothing', () => {
  assert.throws(
    () => resolveSelection({ only: ['prodcts'] }),
    (e) => e instanceof ConfigError && /did you mean "products"/.test(e.message)
  );
});

test('the unknown-name error lists every valid name', () => {
  try {
    resolveSelection({ only: ['nope'] });
    assert.fail('expected a throw');
  } catch (e) {
    for (const r of RESOURCES) assert.match(e.message, new RegExp(r.name.replace(/[-]/g, '[-]')));
  }
});

test('naming a resource that is never cloned is legal and inert', () => {
  const { names } = resolveSelection({ only: ['products', 'carts'] });
  assert.deepEqual(names, ['products']);
});

test('excluding everything is refused rather than run as a no-op', () => {
  assert.throws(() => resolveSelection({ exclude: SELECTABLE }), ConfigError);
});

test('a config file supplies the selection when no flag does', () => {
  const file = configFile({ resources: { exclude: ['orders', 'payments'] } });
  const { names, from } = resolveSelection({ configPath: file });
  assert.equal(names.includes('orders'), false);
  assert.equal(names.includes('payments'), false);
  assert.equal(names.includes('products'), true);
  assert.equal(from, file);
});

test('a flag replaces the config file rather than merging with it', () => {
  const file = configFile({ resources: { exclude: ['orders'] } });
  const { names, from } = resolveSelection({ only: ['products'], configPath: file });
  assert.deepEqual(names, ['products']);
  assert.equal(from, 'flag');
});

test('a config file with include works the same way', () => {
  const file = configFile({ resources: { include: ['types', 'products'] } });
  const { names } = resolveSelection({ configPath: file });
  assert.deepEqual(names, ['types', 'products']);
});

test('a config file with both include and exclude is refused', () => {
  const file = configFile({ resources: { include: ['types'], exclude: ['orders'] } });
  assert.throws(() => resolveSelection({ configPath: file }), ConfigError);
});

test('a config file with no resources key is the same as no file', () => {
  const file = configFile({ somethingElse: true });
  const { names } = resolveSelection({ configPath: file });
  assert.equal(names, null);
});

test('malformed JSON names the file rather than throwing a parse error', () => {
  const file = configFile('{ not json');
  assert.throws(
    () => resolveSelection({ configPath: file }),
    (e) => e instanceof ConfigError && e.message.includes(file)
  );
});

test('a non-array include is refused', () => {
  const file = configFile({ resources: { include: 'products' } });
  assert.throws(() => resolveSelection({ configPath: file }), ConfigError);
});

test('an unknown name in the config file names the file, not a flag', () => {
  const file = configFile({ resources: { exclude: ['oders'] } });
  assert.throws(
    () => resolveSelection({ configPath: file }),
    (e) => e instanceof ConfigError && /ctclone\.config\.json/.test(e.message) && /did you mean "orders"/.test(e.message)
  );
});

test('--config pointing at a missing file is an error, not a silent default', () => {
  assert.throws(() => resolveSelection({ configPath: '/nonexistent/ctclone.config.json' }), ConfigError);
});

test('loadConfigFile returns null for a file that is not there', () => {
  assert.equal(loadConfigFile('/nonexistent/ctclone.config.json'), null);
});

test('every cloneable resource is selectable, and no resource that is never cloned is', () => {
  for (const r of RESOURCES) assert.equal(SELECTABLE.includes(r.name), true, `${r.name} should be selectable`);
  for (const r of NOT_CLONED) assert.equal(SELECTABLE.includes(r.name), false, `${r.name} should not be`);
  assert.equal(SELECTABLE[0], PROJECT_SETTINGS, 'project settings come first — every write depends on them');
});
