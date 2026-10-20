# Features

Code-derived inventory of what this repository implements, each bullet naming the
file that implements it.

`ctclone` (package name `ct-project-clone`) is a dependency-free Node 20+ CLI that
clones data and settings from one commercetools project into another, in any region,
for standing up a new project from an existing one. Entry point is `bin/ctclone.mjs`;
all logic lives under `src/`.

## Clone pipeline and commands

- `clone` runs the full sequence — keyfix, export, import, verify, smoke — behind a
  typed confirmation of the target project key, and writes a JSON report to `logs/`
  (`bin/ctclone.mjs`)
- Every stage is also its own standalone command (`inventory`, `keyfix`, `export`,
  `import`, `verify`, `smoke`, `wipe`), so a run that stops halfway resumes by
  re-running the same or a narrower command (`bin/ctclone.mjs`)
- `--only a,b,c` scopes any command to a subset of resources; `--customer-password`,
  `--prune-project-settings`, `--clone-project-name`, `--bulk-threshold`, `--deep`,
  `--keep-products`, `--yes` and `--verbose` tune individual stages (`bin/ctclone.mjs`)
- `inventory` prints a side-by-side count of every resource on both projects,
  including ones deliberately not cloned, plus each side's languages/countries/
  currencies (`src/inventoryCmd.mjs`)
- Credentials load from `.env.source` / `.env.target` in the Merchant-Center-export
  format, or `SOURCE_CTP_*` / `TARGET_CTP_*` environment variables, with a
  dedicated `ConfigError` (no stack trace) when required fields are missing
  (`src/config.mjs`)

## Key-based identity (the mechanism the whole tool runs on)

- `keyfix` gives every source entity lacking a key a deterministic, re-run-safe key
  derived from its own data (slug/SKU/name/email), so a second run against the same
  entity reproduces the same key instead of minting a new one (`src/keyfix.mjs`)
- Per-resource key strategies for products, customers, inventory (sku + supply
  channel), shopping lists, payments, cart discounts and product discounts (from
  the discount's name), and discount codes (from the code a shopper types, which
  is unique per project where a campaign name is not); name collisions are
  disambiguated with a numeric suffix (`src/keyfix.mjs`)
- `keyfix` is the only write this tool ever makes to the source project — export
  and everything downstream of it is read-only (`src/keyfix.mjs`, `README.md`)
- Orders are deliberately excluded from default keyfix: the platform rejects
  `setKey` on an Order (`Invalid type value 'setKey'`) even though it's in the
  OpenAPI spec, and `orderNumber` already serves as a stable per-project identity
  (`src/keyfix.mjs`)

## Reference rewriting and idempotent write-back

- `export` builds an in-memory index of every source entity id against its key,
  then rewrites every `{typeId, id}` reference into `{typeId, key}` across the
  whole exported tree — the target API resolves keys itself at import time, so
  there is no id-translation table to maintain (`src/refs.mjs`, `src/export.mjs`)
- A reference whose target has no key is tagged `__unresolved` rather than sent
  as a meaningless id; `import` drops just that reference (reporting what it
  dropped) so the rest of the entity still lands (`src/refs.mjs`, `src/import.mjs`)
- `import` is idempotent by key: an entity whose key already exists in the target
  is left alone, so re-running after a partial failure is the same command as
  cloning from scratch (`src/import.mjs`)
- Resource write order is centralized as an `order` number per resource in
  `src/resources.mjs`, guaranteeing a tax category exists before the product that
  references it, a channel before the store that lists it, and shallow categories
  before their children
- Product-selection membership, state transitions, and order payments are wired up
  in dedicated passes after the main resource loop, since each depends on two
  already-created resources on the target side (`src/import.mjs`)
- Enum/lenum attributes are denormalized from `{key,label}` back to a bare key, and
  `set`/`nested` attribute values are recursively reshaped, so a product read out of
  one project can be written into another as a valid draft (`src/attributes.mjs`)

## Bulk writes through the Import API

- A resource with more than `--bulk-threshold` entities to write (default 5000)
  is sent through the commercetools Import API instead of one HTTP request per
  entity — 20 resources per request, so a six-figure inventory costs thousands
  of requests instead of hundreds of thousands (`src/importApi.mjs`)
- Opt-in per resource: a resource declares an `importApi` descriptor in
  `src/resources.mjs` saying how to shape its own import-resource type from the
  already-exported draft; inventory and standalone prices have one today, and
  any other oversized resource falls back to one-request-per-entity and says so
  in the run report rather than going quiet about it (`src/resources.mjs`,
  `src/importApi.mjs`)
- The bulk path filters out what the target already holds and drops the same
  unresolved references the per-entity path does, so a re-run behaves
  identically either way; the difference is that the Import API answers
  "accepted" rather than "written", so the run creates a per-run import
  container, submits batches of 20, and polls the container's summary to
  completion, reporting `imported`/`rejected`/`validationFailed`/`unresolved`
  counts plus a sample of failed operations (`src/importApi.mjs`)
- The Import API is reached at a separate per-region host (`api.` →
  `import.`), derived automatically from `CTP_API_URL` or overridable via
  `CTP_IMPORT_URL` (`src/config.mjs`, `src/client.mjs`)

## Project-settings and locale widening

- Export scans every localized string, price and address it wrote and derives the
  actual languages/countries/currencies in use, rather than trusting the source
  project's declared settings — because the two drift (a project can declare
  `en-US`/`fr-CA` while its data also carries `en-CA`) (`src/locales.mjs`)
- Import widens the target's languages/countries/currencies to the union of the
  source's declared settings and the scanned usage before writing anything else,
  since every later write is rejected if the target doesn't speak them
  (`src/project.mjs`)
- `--prune-project-settings` makes the target match the source's usage exactly
  instead of only adding to what's already configured (`src/project.mjs`)
- Cart configuration (tax rounding, free-shipping thresholds), shipping-rate input
  type, message configuration, and Product Search / product-projection / order /
  customer search-indexing flags are synced as individual project-update actions,
  applied one at a time so one rejection doesn't block the rest (`src/project.mjs`)

## Resource coverage

- Clones project settings, types, tax categories, zones, customer groups, states
  (with transitions wired after creation), channels, product types, categories,
  product selections and their product membership, stores, shipping methods,
  products (with embedded prices and published state), standalone prices,
  inventory, product discounts, cart discounts, discount codes, attribute groups,
  associate roles, customers, business units, shopping lists, custom objects,
  reviews, payments, and orders — 27 resource types in one dependency-ordered list
  (`src/resources.mjs`)
- Deliberately does not clone carts, quotes/quote-requests/staged-quotes (no import
  endpoint), API-client secrets (unrecoverable after creation), extensions and
  subscriptions (credential-bearing destinations, redacted on read), messages/order
  edits/history (event logs), or product tailoring — each with its reason recorded
  in `NOT_CLONED` and surfaced in `inventory`/`verify` output rather than silently
  skipped (`src/resources.mjs`)

## Orders — the one resource with no create-from-draft path

- Orders go through the Order Import API (`POST /orders/import`) rather than
  `POST /orders`, since a live order can only otherwise originate from a real cart;
  the draft is assembled from an already ref-rewritten order (`src/orders.mjs`)
- Every field the import draft can't carry — applied discount codes, cart-level
  direct discounts, return info, sync markers, the originating cart reference,
  and the discount-on-total breakdown — is recorded per order in a `_lossy` list
  rather than dropped silently (`src/orders.mjs`)
- The Order Import API always creates orders `External`-taxed; a source order that
  was `Platform`-taxed arrives with its totals and per-line tax rates intact but
  its tax mode changed, and this is called out per order too (`src/orders.mjs`)
- Payments are attached to an imported order in a follow-up pass (`addPayment`),
  since `paymentInfo` isn't part of the import draft (`src/import.mjs`)
- Every `{typeId, key}` reference inside an order body — including the plain
  `Reference` fields (`state`, `customerGroup`) that a `ResourceIdentifier` key
  would be rejected on — is resolved to a target id before the import call, since
  an id is always accepted where a key sometimes isn't (`src/import.mjs`)

## Verification

- `verify` counts and compares key sets on both sides per resource, plus product-
  selection membership counts and project-settings gaps, and names exactly which
  keys are missing rather than just reporting a mismatched total (`src/verify.mjs`)
- `verify --deep` re-exports the target through the identical normalizer the
  source went through and diffs every draft field by field against the source,
  catching a product that arrived with no prices or a store pointing at the wrong
  channel — cases a matching count would hide. Array fields whose order the API
  doesn't preserve (prices, categories, attributes, rates, ...) are canonicalized
  before diffing so ordering differences don't read as real diffs
  (`src/deepverify.mjs`)
- A fixed list of expected-diff patterns (password hashes, generated address/tax
  ids, order timestamps, the intentional `taxMode` change) is excluded from the
  deep-verify diff so the report only surfaces diffs worth investigating
  (`src/deepverify.mjs`)
- `smoke` drives the live target API rather than just comparing data: a cloned
  customer logs in with the reset password, a product's `productType`/
  `taxCategory`/categories all expand to something real, a store's channels and
  product selections resolve, an order's line items link to real products, Product
  Search is activated and returns a name-based hit, and a SKU is added to and
  removed from a real cart end to end (`src/smoke.mjs`)

## Target reset

- `wipe --confirm <projectKey>` deletes everything cloneable from a target,
  requiring the operator to type the project key back as a confirmation gate
  against wiping the wrong project (`src/wipe.mjs`)
- Deletion runs in reverse dependency order and repeats for up to three passes
  until a pass removes nothing new, since a category with children or a product
  still referenced by a selection refuses the first delete attempt and succeeds
  once its dependents are gone (`src/wipe.mjs`)
- `--only` and `--keep-products` narrow what a wipe touches; orders and payments
  are deleted with `dataErasure: true` (`src/wipe.mjs`)

## API client resilience

- A hand-rolled `CtClient` handles OAuth client-credentials token fetch and reuse
  (refreshing 60s before expiry), retries `429`/`5xx`/network errors with
  exponential backoff honoring a `Retry-After` header, and re-authenticates once on
  a `401` before giving up (`src/client.mjs`)
- Keyset pagination (`id > "<lastId>"`) is used for every list endpoint so paging
  stays correct past the platform's 10k-offset ceiling; a separate offset-based
  paginator is used only where an endpoint (product-selection product listings)
  rejects sorting by id (`src/client.mjs`)
- `mapLimit` runs work over a list with bounded concurrency while preserving
  input order, used throughout export/import/wipe to parallelize per-entity API
  calls without overwhelming the target project's rate limits (`src/client.mjs`)
- Secrets are never logged in full — `redact()` prints only the first 4 characters
  and the total length (`src/config.mjs`)

## Testing

- Offline unit tests (`node --test test/*.test.mjs`, no project or network needed)
  cover reference rewriting, unresolved-reference detection, locale/currency/
  country usage discovery, key derivation (`slugify`), attribute denormalization,
  and the order-import draft builder (`test/transform.test.mjs`)
- A separate offline suite drives the Import API path against a stub client —
  batching into groups of 20, container creation and key derivation, shaping an
  `InventoryImport`, rejected/validation-failed/unresolved operation accounting,
  and the cart-discount/product-discount/discount-code key derivations
  (`test/bulkimport.test.mjs`)
