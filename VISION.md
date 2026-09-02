# Vision

## The problem

Cloudflare has no single official CLI for the whole product. `wrangler` covers the developer
platform and cannot touch DNS; `flarectl` is barely maintained; the REST API is complete but
verbose, and its pagination caps differ per endpoint in ways that quietly truncate results.

So agents reach for `curl` against `api.cloudflare.com`, hand-rolling auth, pagination, and
error handling each time — or load a Cloudflare MCP server and pay its schema overhead on
every turn.

## What cloudflare-axi is

One agent-ergonomic surface over the API v4, following the ten [AXI](https://axi.md)
principles. Its dependency footprint is a single scoped token: no wrangler, no Bun, no MCP
server, no browser login.

It owns three things raw API calls do not:

1. **Declarative mutations.** `dns set` and `email route` express desired state — create,
   patch-only-what-drifted, or no-op. No read-then-write dance, and re-running is safe.
2. **Honest totals.** Every list reports the grand total alongside the page, and pages past
   the per-endpoint caps rather than returning 50 rows that look like all of them.
3. **Refusal to guess.** Ambiguous zones and duplicate records stop and list candidates.

## What it deliberately does not do

- **No zone creation or deletion.** Adding and removing domains is rare, consequential, and
  needs a human at the dashboard.
- **No WAF, Workers, R2, or Pages.** `wrangler` owns the developer platform, and duplicating
  it would mean two tools that drift. This is the DNS-and-delivery surface.
- **No interactive anything.** Every operation completes from flags alone.
- **No credential minting.** The token comes from the environment. This tool never logs in,
  refreshes, or writes a credential to disk.

## Where it could go

- `dns import` / `export` over the zone-file endpoints, which map cleanly onto the existing
  idempotency rules.
- Batched DNS writes through `/dns_records/batch`, turning a multi-record migration into one
  call instead of N.
- Analytics summaries — request and bandwidth rollups are a pre-computed aggregate in the
  AXI sense, and would fit the dashboard.
