# Support

**There is no support for this software.**

It is published under the [MIT License](./LICENSE) so you can freely use, modify, and
redistribute it. That is the entire arrangement. Please read this before you point it at
a project you care about.

## What this means concretely

| | |
|---|---|
| **Warranty** | None. `AS IS`, per the MIT License |
| **Service level** | None. No uptime, response-time, or fix-time commitment of any kind |
| **commercetools Support** | Cannot help with this code. Do not open a support ticket about it — it is not part of any commercetools product or subscription |
| **Issues and pull requests** | Read on a best-effort basis when someone has time. Many will go unanswered. That is not rudeness, it is the stated arrangement |
| **Security fixes** | No commitment to investigate or patch, and no embargo process. Please still report what you find — just do not wait on a fix |
| **Breaking changes** | Possible at any time, without notice, deprecation period, or migration guide |
| **Maintenance** | Not guaranteed to continue. This repository may be archived without warning |

## Not a commercetools product

This code was written by people who work at commercetools, and the copyright is held by
commercetools GmbH and the contributors to the `ct-builders` org. That is the extent of the
relationship. Publishing it here is not an endorsement, a support commitment, or a statement
that this is how commercetools recommends you move data between projects.

For the platform itself — which *is* supported — use the official channels:

- [commercetools documentation](https://docs.commercetools.com)
- [commercetools support portal](https://support.commercetools.com)

## Before you point this at a project that matters

This tool writes to two projects, deletes from one of them on request, and needs
`manage_project` on both. Read that sentence again, then:

- **`wipe` deletes everything cloneable from the target.** It is a real command with a real
  implementation, not a stub. Its only guard is that `--confirm <projectKey>` must match the
  target's key exactly (`src/wipe.mjs`), and that key comes from whatever `.env.target`
  happens to contain. The guard proves you typed a key, not that you typed the *right* key.
- **Check which project `.env.target` resolves to, every time, before you run anything.**
  `npm run inventory` prints both sides and writes nothing. A typo in a project key is the
  one mistake here with no undo. `clone` makes you type the target key to continue; `--yes`
  skips that prompt, so keep it out of anything interactive.
- **`keyfix` writes to the *source* project.** This surprises people who reasonably assume a
  clone tool only reads from the side it is copying. It adds a `key` to source entities that
  lack one, because the whole transfer runs on keys rather than ids (`src/keyfix.mjs`). It is
  the only write made to the source, it is additive, and `--dry-run` shows you the set first.
  Run that first on a project you did not intend to modify.
- **Every cloned customer is created with the same password.** Source passwords are one-way
  hashes and cannot be carried over, so each customer is created with `--customer-password`,
  which **defaults to `123`** (`bin/ctclone.mjs`). If the target is reachable by anyone other
  than you, pass a real one. Customers on `ExternalAuth` are created without a password.
- **Scope the API clients, and retire them afterwards.** Both sides need `manage_project` —
  the source to read everything and set keys, the target to write every resource type. That
  is close to the broadest credential the platform issues. Mint a pair for the migration,
  keep them out of any deployed application, and delete them when the clone is done. Nothing
  in this tool needs to run continuously.
- **`.env.source` and `.env.target` are gitignored. Keep them that way.** They hold client
  secrets in plain text.
- **The clone is faithful, not identical.** Carts, quotes, extensions, subscriptions,
  messages and order edits are not transferred, orders arrive External-taxed whatever they
  were in the source, and some order fields have nowhere to go — each order records what it
  lost under `_lossy` in the export. The README's "What does not, and why" table is the
  complete list, with the reason for each.
- **Verify the result before you trust it.** `verify` compares counts, `verify --deep` diffs
  every entity field by field, and `smoke` drives the live API — logs a cloned customer in,
  resolves a product's references, adds a SKU to a cart, runs a search. A matching count is
  the weakest of the three and agrees with a product that arrived without prices.

## Getting help anyway

Your best options, in order:

1. Read the code. It is commented with the reasoning, not just the mechanics.
   `src/resources.mjs` is the one file to start with — the resource table, the dependency
   order, and the draft shaping all live there. Then `src/refs.mjs` for how an `id`
   reference becomes a `key` reference, `src/keyfix.mjs` for key derivation, and
   `src/importApi.mjs` for the bulk path.
2. Read the tests. `test/transform.test.mjs` and `test/bulkimport.test.mjs` cover reference
   rewriting, locale discovery, enum denormalisation, key derivation and draft shaping. They
   run offline against no project, in about a second, with `npm test`.
3. Read [`FEATURES.md`](./FEATURES.md). It is a code-derived inventory of what is actually
   implemented, which answers "does this handle X" faster than reading `src/`.
4. Open an issue — someone may well answer, just do not depend on it.
5. Fork it. That is what the MIT License is for, and it is the only option with a
   guaranteed outcome.
