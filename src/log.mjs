/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS[process.env.CTCLONE_LOG_LEVEL || 'info'] ?? LEVELS.info;

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

let fileStream = null;
export function logToFile(name) {
  const dir = path.join(ROOT, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.log`);
  fileStream = fs.createWriteStream(file, { flags: 'a' });
  return file;
}

function emit(level, args) {
  if (LEVELS[level] < threshold) return;
  const line = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  if (fileStream) fileStream.write(`${new Date().toISOString()} ${level.toUpperCase()} ${line}\n`);
  const painted =
    level === 'error' ? C.red(line) : level === 'warn' ? C.yellow(line) : level === 'debug' ? C.dim(line) : line;
  process.stderr.write(painted + '\n');
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
  step: (...a) => emit('info', [C.bold(C.cyan('▶ ' + a.join(' ')))]),
  ok: (...a) => emit('info', [C.green('  ✓ ' + a.join(' '))]),
  skip: (...a) => emit('info', [C.dim('  · ' + a.join(' '))]),
  setLevel: (l) => { threshold = LEVELS[l] ?? threshold; },
  colors: C,
};
