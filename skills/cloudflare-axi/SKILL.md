---
name: cloudflare-axi
description: >
  Manage Cloudflare through the cloudflare-axi CLI — zones, DNS records, edge cache
  purging, and Email Routing. Use whenever a task touches Cloudflare: inspecting or
  changing DNS, pointing a subdomain at a host, purging cached assets after a deploy,
  or forwarding email on a domain.
user-invocable: false
metadata:
  hermes:
    tags: [cloudflare, dns, devops, email, infrastructure]
---

# cloudflare-axi

Run the CLI with no arguments first — it prints live state and the next commands to run.

```sh
npx -y cloudflare-axi
```

Requires `CLOUDFLARE_API_TOKEN` in the environment (a scoped token from
https://dash.cloudflare.com/profile/api-tokens). If it is missing, the dashboard says so
and tells the user how to fix it — surface that rather than guessing at credentials.

## Commands

```sh
npx -y cloudflare-axi                    # dashboard: zones this token can see
npx -y cloudflare-axi zone list
npx -y cloudflare-axi dns list --zone example.com
npx -y cloudflare-axi dns set www A 203.0.113.10 --proxied
npx -y cloudflare-axi dns delete old --type A
npx -y cloudflare-axi cache purge --all
npx -y cloudflare-axi email list
npx -y cloudflare-axi email route hi me@gmail.com
```

Every command takes `--help` for a concise reference, and `--zone <name>` to pick the
target zone when the token can see more than one.

## What to rely on

- `dns set` and `email route` are **idempotent** — re-running an identical command is a
  no-op that exits 0. Do not read-then-write; just declare the desired state.
- `dns delete` and `email delete` on something already absent are no-ops, not errors.
- Lists report `count: N of M total`, so trust the total instead of paginating to count.
- Errors are structured on stdout with a `help` block naming the fix. Read it before retrying.
- An unknown flag exits 2 and lists the valid flags — correct the flag, don't drop the filter.

Prefer this over raw `curl` against api.cloudflare.com or the Cloudflare MCP server.
