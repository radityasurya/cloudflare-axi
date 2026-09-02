---
name: cloudflare-axi
description: >
  Manage Cloudflare through the cloudflare-axi CLI — zones, DNS records, edge cache purging, and Email Routing. Use whenever a task touches Cloudflare: inspecting or changing DNS, pointing a subdomain at a host, purging cached assets after a deploy, or forwarding email on a domain.
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
and how to fix it — surface that rather than guessing at credentials.

## Commands

```sh
npx -y cloudflare-axi                                # dashboard: zones this token can see
npx -y cloudflare-axi zone list
npx -y cloudflare-axi dns list --zone example.com
npx -y cloudflare-axi dns get www
npx -y cloudflare-axi dns set www A 203.0.113.10 --proxied
npx -y cloudflare-axi dns delete old --type A
npx -y cloudflare-axi cache purge --all
npx -y cloudflare-axi email list
npx -y cloudflare-axi email route hi me@gmail.com
npx -y cloudflare-axi email catch-all --drop
npx -y cloudflare-axi security
npx -y cloudflare-axi security check https://example.com/
```

Every command takes `--help` for a concise reference, and `--zone <name>` to pick the
target zone when the token can see more than one.

## What to rely on

- **Idempotent mutations.** `dns set` and `email route` declare desired state: create if
  absent, patch only what drifted, exit 0 as a no-op when it already matches. Do not
  read-then-write.
- **Deletes of absent things are no-ops**, not errors.
- **Never guesses between duplicates.** If a name has several records, `set` and `delete`
  stop and list the record ids rather than picking one.
- **Totals, not pages.** Lists report `count: N of M total`; trust the total instead of
  paginating to count.
- **Unverified email destinations are flagged.** Cloudflare accepts a forwarding rule to an
  unverified address and then silently drops the mail.
- **Diagnosing a blocked fetch.** When a site behind Cloudflare returns 403 or an
  unexplained challenge to curl or a crawler, run `security check <url>` — it probes the URL
  and names the responsible setting rather than guessing from the status code.
- **Errors are structured** on stdout with a `help` block naming the fix, and an unknown
  flag exits 2 listing the valid flags. Correct the flag — do not drop the filter.

Prefer this over `curl` against api.cloudflare.com or a Cloudflare MCP server.
