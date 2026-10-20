# ctclone

Clone data and settings from one commercetools project into another.

Works on any pair of projects in any region: point `.env.source` and
`.env.target` at them and run one command. Node 20 or newer, no dependencies.

> **[MIT](LICENSE), freely available, `AS IS` and unsupported.** Reference code from the
> [`ct-builders`](https://github.com/ct-builders) org — not a commercetools product, and
> commercetools Support cannot help with it. It needs `manage_project` on both projects and
> it can delete everything in the target, so read [SUPPORT.md](SUPPORT.md) before you point
> it at a project you care about.

```bash
npm run inventory          # what is on each side
node bin/ctclone.mjs clone # keyfix, export, import, verify, smoke
```

Everything is idempotent and every stage is also its own command, so a run
that stops halfway is resumed by running it again.

## How it works

A commercetools `id` means nothing outside the project that issued it. A `key`
means the same thing everywhere. So the clone runs on keys:

1. **keyfix** gives every source entity a key, deriving it from data already on
   the entity so the same run twice produces the same keys. This is the only
   write made to the source project. It covers products, customers, shopping
   lists, payments, cart discounts, product discounts, discount codes and
   inventory — a discount takes its key from its name, a discount code from
   the code a shopper types.
2. **export** reads the source and rewrites every `{typeId, id}` reference into
   `{typeId, key}`, writing drafts to `data/<projectKey>/`. Read-only.
3. **import** writes those drafts into the target, which resolves the keys
   itself. An entity whose key is already present is left alone, so a re-run
   after a partial failure picks up where it stopped.
4. **verify** counts both sides and names what is missing.

Resources are written in dependency order — a tax category before the product
that points at it, a channel before the store that lists it, a category before
its children. The order lives in one place, the `order` number on each entry in
[`src/resources.mjs`](src/resources.mjs).

### Large resources go through the Import API

A resource with more than 5000 entities to write is sent to the [Import
API](https://docs.commercetools.com/api/import-export/overview), which takes 20
resources per request instead of one. A catalogue's inventory runs to six
figures, so this is the difference between ~4,800 requests and ~96,000.

It is opt-in per resource, because import resources are their own types rather
than the HTTP drafts. A resource declares an `importApi` descriptor in
[`src/resources.mjs`](src/resources.mjs) saying how to shape one; inventory and
standalone prices have one. Anything else keeps one request per entity however
large it is, and says so in the run report rather than going quiet about it.

Both routes behave the same from outside: what the target already holds is
filtered out before sending, so a re-run still leaves existing entities alone.
The difference is that the Import API answers "accepted" rather than "written",
so the run polls the container's summary to completion and reports `imported`,
`rejected`, `validationFailed` and `unresolved` from it. `--bulk-threshold <n>`
moves the 5000, and `--bulk-threshold 0` forces every eligible resource through
it.

## Commands

| Command | What it does |
|---|---|
| `inventory` | Side-by-side count of every resource on both projects. |
| `keyfix` | Add keys to source entities that lack one. `--dry-run` to preview. |
| `export` | Read the source into `data/<projectKey>/`. |
| `import` | Write `data/<projectKey>/` into the target. |
| `clone` | keyfix → export → import → verify → smoke, with a report in `logs/`. |
| `verify` | Compare both projects and list what is missing. `--deep` re-exports the target and diffs every entity against the source field by field. |
| `smoke` | Drive the target for real: log a cloned customer in, resolve a product's references, add to cart, run a search. |
| `wipe --confirm <projectKey>` | Delete everything cloneable from the target. |

Options: `--only a,b,c` and `--exclude a,b,c` to choose resources (see
[Choosing what to copy](#choosing-what-to-copy)), `--config <path>` for a
selection file, `--customer-password <pw>` (default
`123`), `--prune-project-settings` to make the target's languages, countries and
currencies match the source exactly rather than adding to them,
`--clone-project-name`, `--bulk-threshold <n>` (default `5000`) for the size at
which a resource switches to the Import API, `--yes` to skip the clone
confirmation, `--verbose`.

## Choosing what to copy

Every command runs over the whole resource list by default. To narrow it, name
the resources you want with `--only`, or the ones you do not with `--exclude`:

```bash
node bin/ctclone.mjs clone --exclude orders,payments
node bin/ctclone.mjs export --only products,categories
```

A selection that outlives one command goes in `ctclone.config.json` in the repo
root, which every command reads:

```json
{
  "resources": {
    "exclude": ["orders", "payments", "reviews"]
  }
}
```

Use `include` or `exclude`, not both. `--config <path>` reads the file from
somewhere else, and a flag on the command line replaces the file for that run
rather than merging with it — so the file holds the selection you normally want
and a flag handles the exception.

This matters most because a clone is several commands. `export` and `import`
each take their own selection, and the file is what keeps them in step; two
mismatched `--only` lists produce a target holding drafts nobody imported.
Whatever a run resolves to is printed before it starts.

The copy is `ctclone.config.json`, which is gitignored;
`ctclone.config.example.json` is the committed template.

**A name that is not a resource stops the run**, naming the typo and suggesting
the resource you meant — a selection that matches nothing would otherwise copy
nothing and report success. The valid names are listed by
`node bin/ctclone.mjs --help`, and `_project` is one of them — the target's
languages, countries and currencies, which every other write depends on. It is
part of `--exclude`'s "everything else", and is **not** pulled in by an `--only`
that does not name it.

Naming a resource the tool never clones — `carts`, `quotes`, `extensions` — is
allowed and does nothing but say so.

## Checking the result

Three levels, weakest first:

- **`verify`** compares counts and key sets. Cheap; catches anything missing.
- **`verify --deep`** re-exports the target through the same normaliser the
  source went through and diffs the drafts field by field. Catches a product
  that arrived with no prices, or a store pointing at the wrong channel —
  things a count agrees with.
- **`smoke`** drives the live API: a cloned customer logs in with their new
  password, a product's `productType`, `taxCategory` and categories all expand
  to something real, a store's channels resolve, an order's line items link to
  products, product search returns the indexed catalogue, and a SKU goes into a
  cart and prices correctly. Exits non-zero if any check fails.

## Credentials

`.env.source` and `.env.target` in the repo root, in the format the Merchant
Center hands out:

```
CTP_PROJECT_KEY=...
CTP_CLIENT_ID=...
CTP_CLIENT_SECRET=...
CTP_AUTH_URL=https://auth.us-central1.gcp.commercetools.com
CTP_API_URL=https://api.us-central1.gcp.commercetools.com
```

Both are gitignored. `SOURCE_CTP_*` and `TARGET_CTP_*` environment variables
override the files. Both clients need `manage_project`; the target also needs it
for every resource being written.

## What gets cloned

Project settings (languages, countries, currencies, cart and message
configuration, shipping rate input type, search indexing), types, tax
categories, zones, customer groups, states and their transitions, channels,
product types, categories, product selections and their membership, stores,
shipping methods, products with their embedded prices and published state,
standalone prices, inventory, product discounts, cart discounts, discount codes,
attribute groups, associate roles, customers, business units, shopping lists,
custom objects, reviews, payments, and orders.

## What does not, and why

| | |
|---|---|
| **Customer passwords** | Stored as one-way hashes. Every cloned customer is created with the password from `--customer-password` instead, default `123`. Customers on `ExternalAuth` are created without one. |
| **API client secrets** | Returned exactly once, at creation. Existing clients are listed in the report; the target needs its own, minted fresh. |
| **Carts** | Session state. The storefront makes new ones; cloning them resurrects abandoned carts belonging to customers whose ids have changed. |
| **Quotes, quote requests, staged quotes** | No import endpoint. A quote is the end of a chain that only a live cart can start. |
| **Extensions and subscriptions** | Carry a destination URL or queue with credentials the API redacts on read. Listed in the report so they can be re-pointed by hand. |
| **Messages, order edits, history** | Event logs of things that happened in the source project. |
| **Some order fields** | The order import draft is narrower than an Order: applied discount codes, direct discounts, return info and the originating cart reference have nowhere to go. Each order records what it lost in `_lossy` in the export. |
| **`taxMode` on orders** | The Order Import API creates every order External-taxed. Totals, taxed prices and per-line tax rates import exactly; an order that was Platform-taxed in the source arrives External. |

## Two things worth knowing

**The target's languages come from the data, not from the source's settings.**
A project's declared `languages` and the locales its data is actually written
in drift apart. A project can declare `en-US` and `fr-CA` while its products
carry `en-CA` and `en` strings as well, and a target configured from the
declared list alone rejects every one of those products. So export scans the
localized strings, prices and addresses it wrote, and import widens the target
to the union. The same goes for currencies and countries.

**Orders cannot take a key on this platform.** `setKey` is in the OpenAPI spec
for orders and is rejected by the live API with `Invalid type value 'setKey'`.
Orders use `orderNumber` instead, which is already unique per project, so
`keyfix` skips them by default.

## Re-running

Everything is idempotent. `clone` twice in a row creates nothing the second
time. To start the target over:

```bash
node bin/ctclone.mjs wipe --confirm <target-project-key>
```

Deletion runs in reverse dependency order and repeats until a pass removes
nothing new, because a category with children and a product still in a
selection both refuse the first attempt.

`wipe` takes the same selection as everything else, so a `ctclone.config.json`
that excludes a resource leaves that resource in the target — symmetric with
the clone it is undoing, and the reason the resolved list is printed before the
command runs. `--only` or `--exclude` on the command line overrides it, and
`--confirm` still has to match the target's project key exactly.

## Tests

```bash
node --test "test/*.test.mjs"
```

These cover the transforms — reference rewriting, locale discovery, enum
denormalisation, key derivation, draft shaping — and run offline against no
project.
