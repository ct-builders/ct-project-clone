# Contributing

Contributions are welcome. This repository is part of the
[`ct-builders`](https://github.com/ct-builders) org, which publishes reference code for
commercetools under the [MIT License](./LICENSE), `AS IS` and unsupported.

Please note the [support policy](./SUPPORT.md) before you invest much effort: pull requests
are read on a best-effort basis, and there is no response-time commitment.

## Two hard requirements

**1. Every source file carries the SPDX license header.**

```js
/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */
```

No exceptions, including files you only edited. The header is what makes the terms survive
a single file being copied out of context — which is how most of this code will actually be
consumed. A PR that adds a source file without it will be asked to add it.

**2. You may only contribute code you have the right to license under MIT.**

Do not paste in code from another project, a customer engagement, a vendor's repository, or
a Stack Overflow answer unless its license permits redistribution under MIT *and* you
preserve the original copyright notice. If a file or directory is substantially someone
else's work, keep their license file alongside it and leave their headers intact — do not
overwrite them with ours.

If you are unsure whether you may contribute something, do not contribute it.

## This is a public repository

Public, permanently, including git history. Never commit:

- **Credentials of any kind** — API client secrets, tokens, passwords, private keys. Not
  even expired ones, and not even "just in a test fixture".
- **Customer or prospect names**, or anything identifying a specific commercial engagement.
- **Internal infrastructure** — internal hostnames, cloud project ids, commercetools project
  keys, database names, internal ticket references, internal tooling.
- **Personal data.** Use obviously-synthetic fixtures (`jane@example.com`).
- **Exported data.** `data/` and `logs/` are gitignored because a clone run fills them with
  a real project's catalog, customers and orders. Do not add a fixture captured from a live
  project; write a synthetic one.

If you commit a secret by accident, treat it as leaked: rotate it first, then worry about
the history.

## Before you open a PR

```bash
npm test
```

That is `node --test 'test/*.test.mjs'`, it needs no credentials and no network, and it
finishes in about a second. **There is no CI in this repository** — that command is the
whole gate, so a PR that has not run it has not been checked by anything.

There is no build step, no typecheck and no lint, because there are no dependencies and no
TypeScript. Keep it that way (see below).

**Testing against real projects is a deliberate, manual act.** Nothing in `npm test` talks
to commercetools. If your change touches the export, import or wipe paths, exercise it
against two projects you are willing to have written to — `npm run inventory` first to
confirm which ones those are, then a narrow `--only <resource>` run rather than a full
clone. Do not add a credential-dependent test to `test/`; the offline suite is the gate and
it stays fast.

## What good looks like here

This repository optimizes for **being read**. People land in it to understand how a
key-based transfer works before writing their own, so:

- **Comment the *why*, not the *what*.** `// add the key` is noise. "A commercetools `id`
  means nothing outside the project that issued it and a `key` means the same thing
  everywhere, so the transfer runs on keys" is the reason the code is shaped the way it is,
  and it cannot be recovered from reading it.
- **Match the surrounding code.** Its naming, its comment density, its idioms. A PR that
  introduces a second style makes the codebase harder to read even if the new style is
  better in isolation.
- **Keep it dependency-free.** This runs on plain Node 20+ ESM with no `node_modules`. That
  is a deliberate property, not an accident of youth: it makes a tool that holds
  `manage_project` credentials on two projects auditable by reading it. Adding a dependency
  needs a real argument.
- **Every resource belongs in `src/resources.mjs`.** The resource table carries the endpoint,
  the dependency `order`, the key strategy and the draft shaping for each type, in one place.
  Adding a resource means adding an entry, not a new code path — and the `order` number is
  what guarantees a tax category exists before the product that points at it.
- **Keep every stage idempotent and resumable.** A run that stops halfway is resumed by
  running it again, because what the target already holds is filtered out before sending.
  This is the property that makes the tool usable on a catalog large enough to fail
  partway. A change that makes a second run create duplicates is a bug, however much faster
  it is.
- **Reference rewriting goes through `src/refs.mjs`.** Every `{typeId, id}` becomes
  `{typeId, key}` in one place. A resource that reaches into a draft and rewrites a
  reference itself is how one resource type quietly stops resolving.
- **Transforms are testable offline, and tested.** Reference rewriting, locale discovery,
  enum denormalisation, key derivation and draft shaping are all pure functions over data,
  which is why `test/` can cover them without credentials. If you add one, extend the suite.
  "I ran it against my project once" is not coverage.
- **Keep it project-agnostic.** Nothing about a particular project, region or catalog
  belongs in the code. Credentials and URLs come from `.env.source` / `.env.target` or the
  `SOURCE_CTP_*` / `TARGET_CTP_*` environment variables; anything an operator should be able
  to change belongs on the command line, not in a constant.
- **Anything destructive stays guarded and loud.** `wipe` requires `--confirm <projectKey>`
  matching the target exactly, and `clone` makes the operator type the target key. Do not
  add a flag that bypasses one of those, and do not widen `--yes`.

## Reporting a security issue

Open a GitHub issue. There is no private disclosure channel and no embargo process for this
repository — so if the issue is genuinely sensitive, please weigh that before filing.

**Do not** report commercetools *platform* vulnerabilities here. Those go to
[commercetools' official security contact](https://commercetools.com/privacy-and-security).
