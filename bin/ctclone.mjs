#!/usr/bin/env node
/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ConfigError } from '../src/config.mjs';
import { CtClient } from '../src/client.mjs';
import { log, logToFile } from '../src/log.mjs';
import { keyfix, DEFAULT_KEYFIX, KEY_STRATEGIES } from '../src/keyfix.mjs';
import { exportProject, dataDir } from '../src/export.mjs';
import { importProject } from '../src/import.mjs';
import { verify, renderVerify } from '../src/verify.mjs';
import { deepVerify, renderDeepVerify } from '../src/deepverify.mjs';
import { inventory, renderInventory } from '../src/inventoryCmd.mjs';
import { smoke, renderSmoke } from '../src/smoke.mjs';
import { wipe } from '../src/wipe.mjs';
import { IN_ORDER } from '../src/resources.mjs';
import { resolveSelection } from '../src/selection.mjs';
import { BULK_THRESHOLD } from '../src/importApi.mjs';

const USAGE = `
ctclone — clone data and settings between two commercetools projects

  Credentials come from .env.source and .env.target in the repo root
  (or SOURCE_CTP_* / TARGET_CTP_* environment variables).

COMMANDS
  inventory                     Count every resource on both sides.
  keyfix                        Add keys to source entities that lack one.
                                This is the only write made to the source.
  export                        Read the source to data/<projectKey>/.
  import                        Write data/<projectKey>/ into the target.
  clone                         keyfix, export, import, verify, smoke.
  verify                        Compare both sides and report what is missing.
  smoke                         Drive the target: log a customer in, resolve a
                                product's references, add to cart, search.
  wipe --confirm <projectKey>   Delete everything cloneable from the target.

OPTIONS
  --only a,b,c                  Limit to these resources.
  --exclude a,b,c               Every resource except these. Not with --only.
  --config <path>               Selection file (default: ctclone.config.json
                                in the repo root, if it exists). A flag above
                                replaces whatever the file says.
  --dry-run                     keyfix only: report what it would key.
  --customer-password <pw>      Password set on every cloned customer
                                (default: 123). Source passwords are hashed
                                and cannot be read.
  --prune-project-settings      Make the target's languages/countries/
                                currencies match the source exactly instead
                                of adding to what is already there.
  --clone-project-name          Also copy the source's project name.
  --bulk-threshold <n>          Entities above which a resource is written
                                through the Import API, 20 at a time, rather
                                than one request each (default: 5000).
  --deep                        verify only: re-export the target and diff
                                every entity against the source field by field.
  --keep-products               wipe only: leave products in place.
  --yes                         Skip the confirmation prompt on clone.
  --verbose                     Debug logging.

RESOURCES
  ${IN_ORDER.map((r) => r.name).join(', ')}
`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      const next = argv[i + 1];
      if (inline !== undefined) out.flags[k] = inline;
      else if (next && !next.startsWith('--')) { out.flags[k] = next; i++; }
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : null);

/** A flag that must be a non-negative number, or the default if absent. */
function numeric(v, fallback) {
  if (v === undefined || v === true) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`--bulk-threshold must be a non-negative number, got "${v}"`);
  return n;
}

/**
 * Narrow a resource selection to the handful of resources that can take a
 * derived key. A selection is usually much broader than that — a config file
 * excluding one resource names twenty-five — and passing it through whole
 * would warn once per resource that was never keyable in the first place.
 */
function keyfixSelection(only) {
  return only ? only.filter((n) => KEY_STRATEGIES[n]) : DEFAULT_KEYFIX;
}

async function confirm(question) {
  process.stdout.write(`${question} `);
  return new Promise((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (d) => resolve(d.trim()));
    process.stdin.resume();
  });
}

async function main() {
  const { _: positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || flags.help || command === 'help') {
    process.stdout.write(USAGE);
    return;
  }
  if (flags.verbose) log.setLevel('debug');

  const selection = resolveSelection({
    only: list(flags.only),
    exclude: list(flags.exclude),
    configPath: typeof flags.config === 'string' ? flags.config : null,
  });
  const only = selection.names;
  if (only) {
    const where =
      selection.from === 'flag' ? 'command line' : path.relative(ROOT, selection.from) || selection.from;
    log.info(`Resources (${only.length}, from ${where}): ${only.join(', ')}`);
  }

  const options = {
    customerPassword: typeof flags['customer-password'] === 'string' ? flags['customer-password'] : '123',
    pruneProjectSettings: !!flags['prune-project-settings'],
    cloneProjectName: !!flags['clone-project-name'],
    bulkThreshold: numeric(flags['bulk-threshold'], BULK_THRESHOLD),
  };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = logToFile(`${command}-${stamp}`);

  const newSource = () => new CtClient('source');
  const newTarget = () => new CtClient('target');

  switch (command) {
    case 'inventory': {
      const [s, t] = [newSource(), newTarget()];
      process.stdout.write(renderInventory(await inventory(s, t)) + '\n');
      break;
    }

    case 'keyfix': {
      const names = keyfixSelection(only);
      if (!names.length) {
        throw new ConfigError(
          `None of the selected resources can take a derived key.\n` +
            `  keyfix covers: ${Object.keys(KEY_STRATEGIES).join(', ')}`
        );
      }
      const s = newSource();
      const summary = await keyfix(s, { only: names, dryRun: !!flags['dry-run'] });
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
      break;
    }

    case 'export': {
      const s = newSource();
      const report = await exportProject(s, { only, options });
      process.stdout.write(`\nexported to ${path.relative(ROOT, dataDir(s.projectKey))}/\n`);
      process.stdout.write(summariseExport(report) + '\n');
      break;
    }

    case 'import': {
      const s = newSource();
      const t = newTarget();
      const ctx = await importProject(t, { sourceKey: s.projectKey, only, options });
      process.stdout.write(summariseImport(ctx) + '\n');
      break;
    }

    case 'clone': {
      const s = newSource();
      const t = newTarget();
      log.info(`source  ${s.projectKey}`);
      log.info(`target  ${t.projectKey}`);
      if (!flags.yes) {
        const answer = await confirm(`\nClone ${s.projectKey} into ${t.projectKey}? Type the target key to continue:`);
        if (answer !== t.projectKey) {
          log.error('Aborted.');
          process.exitCode = 1;
          return;
        }
      }

      const keyNames = keyfixSelection(only);
      if (!keyNames.length) log.skip('keyfix: nothing in this selection takes a derived key');
      const keySummary = keyNames.length ? await keyfix(s, { only: keyNames }) : {};
      const exportReport = await exportProject(s, { only, options });
      const ctx = await importProject(t, { sourceKey: s.projectKey, only, options });
      const result = await verify(s, t);
      const checks = await smoke(t, { customerPassword: options.customerPassword });

      const report = {
        ranAt: new Date().toISOString(),
        source: s.projectKey,
        target: t.projectKey,
        keyfix: keySummary,
        export: exportReport,
        import: ctx.results,
        warnings: ctx.warnings,
        verify: result.rows,
        settingsGaps: result.settingsGaps,
        smoke: checks,
        customerPassword: options.customerPassword,
      };
      const reportFile = path.join(ROOT, 'logs', `clone-report-${stamp}.json`);
      fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

      process.stdout.write(summariseImport(ctx) + '\n');
      process.stdout.write(renderVerify(result) + '\n');
      process.stdout.write(renderSmoke(checks) + '\n');
      process.stdout.write(`\nreport  ${path.relative(ROOT, reportFile)}\nlog     ${path.relative(ROOT, logFile)}\n`);
      if (checks.some((c) => !c.ok) || result.rows.some((r) => r.missing)) process.exitCode = 1;
      break;
    }

    case 'verify': {
      const s = newSource();
      const t = newTarget();
      process.stdout.write(renderVerify(await verify(s, t)) + '\n');
      if (flags.deep) {
        process.stdout.write(renderDeepVerify(await deepVerify(s, t)) + '\n');
      }
      break;
    }

    case 'smoke': {
      const t = newTarget();
      const checks = await smoke(t, { customerPassword: options.customerPassword });
      process.stdout.write(renderSmoke(checks) + '\n');
      if (checks.some((c) => !c.ok)) process.exitCode = 1;
      break;
    }

    case 'wipe': {
      const t = newTarget();
      const result = await wipe(t, {
        confirmProjectKey: flags.confirm,
        only,
        keepProducts: !!flags['keep-products'],
      });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      break;
    }

    default:
      process.stderr.write(`Unknown command "${command}".\n${USAGE}`);
      process.exitCode = 1;
  }
}

function summariseExport(report) {
  const lines = [];
  for (const [name, r] of Object.entries(report.resources)) {
    if (r.unavailable) continue;
    lines.push(`  ${name.padEnd(26)}${String(r.exported).padStart(6)}${r.withoutIdentity ? `   ${r.withoutIdentity} without a key` : ''}`);
  }
  if (report.unresolvedReferences?.length) {
    lines.push(`  ${report.unresolvedReferences.length} entities reference something with no key`);
  }
  return lines.join('\n');
}

function summariseImport(ctx) {
  const lines = ['', 'import'];
  for (const [name, r] of Object.entries(ctx.results)) {
    if (!r || typeof r !== 'object') continue;
    if (r.total === 0) continue;
    const bits = [];
    if (r.created !== undefined) bits.push(`${r.created} created`);
    if (r.existing) bits.push(`${r.existing} already there`);
    if (r.failed) bits.push(`${r.failed} FAILED`);
    if (r.assigned !== undefined) bits.push(`${r.assigned} assigned`);
    if (r.updated !== undefined) bits.push(`${r.updated} updated`);
    if (r.attached !== undefined) bits.push(`${r.attached} attached`);
    if (r.actions !== undefined) bits.push(`${r.actions} actions applied`);
    if (bits.length) lines.push(`  ${name.padEnd(30)}${bits.join(', ')}`);
  }
  if (ctx.warnings.length) {
    lines.push('', `warnings (${ctx.warnings.length})`);
    for (const w of ctx.warnings.slice(0, 20)) lines.push(`  ${w}`);
    if (ctx.warnings.length > 20) lines.push(`  ...and ${ctx.warnings.length - 20} more, see the log`);
  }
  return lines.join('\n');
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    // A setup problem is the user's to fix, not a crash to debug.
    log.error(err instanceof ConfigError ? err.message : err.stack || err.message);
    process.exit(1);
  });
