# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build,
test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## What this is

`cloudflare-axi` talks to the Cloudflare API v4 directly over `fetch`. Unlike `gh-axi`
(which wraps `gh`) or the sibling `coolify-axi` (which wraps the `coolify` CLI), there is no
single official Cloudflare CLI covering zones, DNS, cache, and Email Routing — `wrangler` is
scoped to the developer platform and does not touch DNS. Wrapping the REST API keeps the
dependency footprint at one scoped token, with no Bun or wrangler install.

## Toolchain differs from gh-axi deliberately

gh-axi is TypeScript + pnpm + vitest + eslint. This package is plain ESM JavaScript + npm +
`node:test`, with no build step. The AXI contract is about the *interface* the agent sees,
not the authoring language, and a zero-build package keeps `npx -y cloudflare-axi` fast
because there is no `dist/` to publish. Do not convert for symmetry alone.

## Endpoint shapes came from Cloudflare's OpenAPI, not from memory

Every path and request body was verified against
`https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json` (~24 MB, 2122
paths). Two things that recall would have gotten wrong:

- **Email Routing rules** need `matchers: [{ type: "literal", field: "to", value }]` and
  `actions: [{ type: "forward", value: [addresses] }]`. The catch-all variant is a `PUT` to
  `.../rules/catch_all` with `matchers: [{ type: "all" }]`.
- **Cache purge** accepts exactly one selector per call — `purge_everything`, `files`,
  `hosts`, `prefixes`, or `tags` (an `anyOf`, not a merge). Sending two is a request error,
  so `src/commands/cache.js` rejects it before the call.

Re-verify against that schema before adding an endpoint.

## `per_page` caps differ per endpoint (`src/api.js`)

`/zones` and `/zones/{id}/email/routing/rules` cap `per_page` at **50**; DNS records allow
up to 5,000,000. A naive `per_page=100` silently returns 50 zones and looks like a complete
answer. `cfList()` pages transparently and reports `result_info.total_count` separately, so
`count: N of M total` stays honest. `PAGE_MAX` records both caps — a new endpoint needs its
own entry rather than the default.

## The SDK does not re-export its TOON encoder (`src/cli.js`)

`axi-sdk-js`'s `index.d.ts` re-exports `cli`, `errors`, `hooks`, and `update` — **not**
`output`. `renderOutput` is therefore not importable, even though the SDK uses it internally
to render command output. Static top-level help must encode through `@toon-format/toon`
directly, which is why that package is a direct dependency. Command handlers do not need it:
they return plain objects and the SDK renders them.

## Idempotent `dns set` compares only what was asked for (`src/commands/dns.js`)

`desiredFrom()` builds the desired state from the flags the caller actually passed, plus
content. Comparison then runs over that object's keys only — so omitting `--ttl` does not
count the existing TTL as drift and does not send it in the PATCH. A test asserts the PATCH
body is `{ content }` alone. If a new flag is added, it must go through `desiredFrom()` or
it will silently never apply.

## Duplicate records are a stop, not a guess

A name with several records of the same type (round-robin A records) makes `set` and
`delete` ambiguous. Both refuse and list the record ids. Preserve that: silently patching
the first match is how an agent points production at one of three backends.

## `resolveZone` order is flag > env > sole zone (`src/api.js`)

With several zones visible and no `--zone`, it raises `VALIDATION_ERROR` listing candidates
rather than picking one. The 32-hex check distinguishes a zone id from a name; a name goes
through `?name=` which is an exact match, not a search.

## Unverified email destinations (`src/commands/email.js`)

Cloudflare accepts a forwarding rule pointing at an unverified destination address and then
silently drops the mail. `route` cross-checks the account's destination list and warns. That
lookup is account-scoped, so it is wrapped in a `catch` — a zone-only token still routes
mail, it just does not get the warning.

## Installable skill (`src/skill.js` → `skills/cloudflare-axi/SKILL.md`)

The shipped skill stays a minimal stub and defers to the CLI for actual guidance. Regenerate
with `npm run build:skill`; CI runs `npm run check:skill` and `guard-generated-files.yml`
blocks hand-edits under `skills/`.

## Release process

Releases are cut by release-please from conventional commits on `main`; merging the bot's
release PR triggers `npm publish` via `.github/workflows/release-please.yml`. Do not
hand-edit `CHANGELOG.md` or `.release-please-manifest.json` — a guard workflow blocks PRs
that touch them.

Publishing uses **npm trusted publishing (OIDC)**, not a stored token. The workflow's
`id-token: write` permission lets npm verify the workflow's identity directly, so there is
no `NPM_TOKEN` secret to rotate or leak, and provenance is attested automatically. The npm
account is passkey-protected with `two-factor auth: auth-and-writes`, so any token capable
of unattended publishing would be a deliberate hole in that 2FA.

The trust relationship is registered once, against the **workflow filename**:

```sh
npm trust github cloudflare-axi --repo radityasurya/cloudflare-axi --file release-please.yml --allow-publish
```

Renaming `release-please.yml` therefore breaks publishing until the relationship is
re-registered. `npm trust list cloudflare-axi` shows the current configuration.

## Testing without a Cloudflare account

`tests/helpers.js#mockCloudflare` stubs `globalThis.fetch` with a route table keyed on
`"METHOD /path"` and returns the call log, so tests assert the exact request bodies sent —
not just that a call happened. No network, no token, no account required.

## Test discovery: `tests/`, not `test/` (CI caught this)

Two traps stacked here, both surfaced only on Node 20 in CI:

- `node --test "test/*.test.js"` needs the runner to expand the glob itself, which is
  **Node 22+**. On Node 20 the pattern is taken literally and the run fails with
  `Could not find '.../test/*.test.js'`. The script is therefore a bare `node --test`,
  relying on default discovery.
- Default discovery treats **every file under a directory named `test`** as a test file, not
  just `*.test.js`. That ran `fake-coolify.mjs` (which exits 1 by design when handed an
  unknown command) as a test, and reported `helpers.js` as an empty passing test.

Naming the directory `tests` fixes both: `tests/*.test.js` still matches the default
`**/*.test.js` pattern by name, while `tests/helpers.js` and `tests/fixtures/**` match none
of the default patterns and stay out of the run. Do not rename it back to `test/`.

## Bot management writes echo the full config (`src/commands/security.js`)

`security ai-bots` reads the current `/zones/{id}/bot_management` object, drops the fields
Cloudflare computes (`using_latest_model`, `is_robots_txt_managed`,
`ai_bots_migration_opt_out`), changes one field, and PUTs the whole thing back. The
endpoint's schema declares four `oneOf` variants with no required properties, which reads
as "partial updates accepted" — but echoing the full object is correct whether the endpoint
patches or replaces, and a wrong guess silently resets twelve unrelated protections on a
live zone. Verified on a real zone: all 13 fields survived the write with only
`ai_bots_protection` changed.

## Diagnosis ranks causes, and the ranking is load-bearing

`security check` reports `browser_check` and `security_level` as *contributing*, never as
the verdict. Measured across real zones, both are `on`/`medium` almost everywhere —
including zones that serve AI crawlers perfectly well — so leading with either buries the
setting that actually differs. `ai_bots_protection` was the real cause on three zones while
`browser_check` was identical on all four, including the one that worked.
