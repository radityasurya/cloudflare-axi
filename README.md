<h1 align="center">cloudflare-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/cloudflare-axi"><img alt="npm" src="https://img.shields.io/npm/v/cloudflare-axi?style=flat-square" /></a>
  <a href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square" /></a>
  <a href="https://axi.md"><img alt="AXI" src="https://img.shields.io/badge/built%20with-AXI-black?style=flat-square" /></a>
</p>

<h3 align="center">Cloudflare CLI for agents.</h3>

Manage Cloudflare **zones, DNS records, edge cache, and Email Routing** from the shell,
designed with [AXI](https://axi.md) (Agent eXperience Interface).

Talks to the Cloudflare API v4 directly — no `wrangler`, no Bun, no MCP server. One
scoped API token is the entire dependency footprint, plus [`axi-sdk-js`](https://www.npmjs.com/package/axi-sdk-js)
for the shared AXI runtime.

## Why

Cloudflare has no single official CLI for this surface — `wrangler` is scoped to the
developer platform and cannot touch DNS. So agents fall back to `curl` against
`api.cloudflare.com`, re-deriving auth, pagination, and error handling every time.

Three things that costs them, which this fixes:

- **Truncated listings that look complete.** `/zones` and Email Routing rules cap `per_page`
  at 50. A request for 100 returns 50 and no indication it was clipped. `cloudflare-axi`
  pages transparently and reports `count: N of M total`.
- **Read-then-write round trips.** `dns set` and `email route` are declarative: create if
  absent, patch only what drifted, no-op when already correct. One call instead of three.
- **Wrong-record writes.** A name with several records of the same type is ambiguous;
  raw API calls happily patch the first hit. This stops and lists the record ids.

Endpoint shapes are verified against
[Cloudflare's published OpenAPI schema](https://github.com/cloudflare/api-schemas), not
recalled — see [AGENTS.md](AGENTS.md).

## Quick Start

Install the skill in the [Agent Skills](https://agentskills.io) format:

```sh
npx skills add radityasurya/cloudflare-axi --skill cloudflare-axi -g
```

That is the entire setup — no npm install needed. The skill is a discovery stub that
sends your agent to the always-current `npx -y cloudflare-axi` dashboard, so it cannot
go stale against a newer CLI.

Then export a token:

```sh
export CLOUDFLARE_API_TOKEN=...   # or CF_API_TOKEN
```

Create one at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens).
Minimum permissions per command group:

| Commands  | Token permission                          |
| --------- | ----------------------------------------- |
| `zone`    | Zone → Zone → Read                        |
| `dns`     | Zone → DNS → Edit                         |
| `cache`   | Zone → Cache Purge → Purge                |
| `email`   | Zone → Email Routing Rules → Edit, and Account → Email Routing Addresses → Read |

## Other Ways to Install

### Zero setup

It's an AXI, so any capable agent can run it with nothing installed:

```
Execute `npx -y cloudflare-axi` for Cloudflare operations.
```

### Session hook

For ambient context — your zones visible at the start of every agent session:

```sh
npm install -g cloudflare-axi
cloudflare-axi setup hooks
```

Installs a `SessionStart` hook for **Claude Code**, **Codex**, and **OpenCode**.
Restart your agent session afterwards. `cloudflare-axi setup status` reports what is
installed; `cloudflare-axi setup uninstall` removes it. You need either the hook or the
skill, not both.

## Usage

```bash
cloudflare-axi                                  # dashboard — zones, no args needed
cloudflare-axi zone list
cloudflare-axi zone view example.com            # nameservers + record count

cloudflare-axi dns list --zone example.com
cloudflare-axi dns list --type A --limit 20
cloudflare-axi dns get www                      # TTL, proxy state, record id
cloudflare-axi dns set www A 203.0.113.10 --proxied
cloudflare-axi dns set @ MX mx.example.net --priority 10
cloudflare-axi dns set api CNAME app.fly.dev --ttl 300 --no-proxied
cloudflare-axi dns delete old --type A

cloudflare-axi cache purge --all
cloudflare-axi cache purge --url https://example.com/app.css --url https://example.com/app.js
cloudflare-axi cache purge --prefix https://example.com/assets/

cloudflare-axi email list                       # rules + routing status + catch-all
cloudflare-axi email addresses                  # destinations, and whether verified
cloudflare-axi email route hi me@gmail.com
cloudflare-axi email route support@example.com a@gmail.com b@gmail.com
cloudflare-axi email catch-all me@gmail.com
cloudflare-axi email catch-all --drop
cloudflare-axi email delete hi

cloudflare-axi security                         # bot protection + challenge settings
cloudflare-axi security check https://example.com/   # why can't a bot fetch this?
cloudflare-axi security rules                   # custom WAF rules

cloudflare-axi update --check                   # newer release available?
```

### Commands

| Command | Subcommands | Purpose |
| --- | --- | --- |
| *(none)* | — | Dashboard: zones this token can see |
| `zone` | `list`, `view` | Zones, nameservers, record counts |
| `dns` | `list`, `get`, `set`, `delete` | DNS records, idempotent writes |
| `cache` | `purge` | Edge cache purging |
| `email` | `list`, `addresses`, `route`, `catch-all`, `delete` | Email Routing |
| `security` | `show`, `rules`, `check` | Bot protection, WAF rules, and challenge diagnosis |
| `setup` | `hooks`, `status`, `uninstall` | Agent session integration |

Every subcommand takes `--help` for a concise reference with its flags and examples.

### Global flags

| Flag | Effect |
| --- | --- |
| `--zone <name\|id>` | Target a zone by name or id (or `CLOUDFLARE_ZONE`) |
| `--account <id>` | Target an account when the token spans several |
| `--help` | Print the command reference; always allowed, never reported as unknown |

Flags must come **after** the command (`cloudflare-axi dns list --type A`, not
`cloudflare-axi --type A dns list`).

### Choosing the zone

Commands that act on a zone resolve it in this order:

1. `--zone <name|id>`
2. `CLOUDFLARE_ZONE`
3. the only zone the token can see

If the token spans several zones and none was named, the command fails with the
candidate zones listed rather than guessing.

`--account <id>` does the same for the account-scoped `email addresses` command.

## Behaviour worth relying on

- **Idempotent mutations.** `dns set` and `email route` declare desired state: create if
  absent, patch only the fields that drifted, and exit 0 with `unchanged: true` when it
  already matches. `dns delete` and `email delete` on something already gone are no-ops,
  not errors. Agents never need a read-then-write dance.
- **Never guesses between duplicates.** If a name has several records, `set` and `delete`
  stop and list the record ids instead of picking one.
- **Totals, not pages.** Lists report `count: N of M total`, so the agent knows the real
  size in one call. `/zones` and email rules cap at 50 per page upstream; the client pages
  transparently.
- **Unverified email destinations are flagged.** Cloudflare accepts a forwarding rule to an
  unverified address and then silently drops the mail; `email route` warns when that happens.
- **Fails loud.** Unknown flags exit 2 and name the valid flags for that subcommand inline,
  so the agent corrects in one turn instead of calling `--help`.
- **TOON output** on stdout, structured errors on stdout too, diagnostics on stderr.

## Development

```sh
npm install
npm test              # node:test, no framework, no network
npm run build:skill   # regenerate skills/cloudflare-axi/SKILL.md from src/skill.js
npm run check:skill   # CI drift check
node bin/cloudflare-axi.js --help
```

The tests stub `fetch` with a route table standing in for Cloudflare, so the suite asserts
the exact request bodies sent for DNS patches, cache purges, and email rules — not merely
that a call happened. No token or account required.

See [AGENTS.md](AGENTS.md) for architecture and sharp-edge notes, and
[CONTRIBUTING.md](CONTRIBUTING.md) for the release process.

## License

MIT
