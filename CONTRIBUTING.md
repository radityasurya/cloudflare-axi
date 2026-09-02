# Contributing

## Getting set up

```sh
npm install
npm test
```

Node 20+ is required; CI runs the suite on 20, 22, and 24. There is no build step and no
transpile — `bin/cloudflare-axi.js` runs `src/` directly.

The test suite needs no Cloudflare account and makes no network calls. It runs against a stubbed
`globalThis.fetch` with a route table, so tests assert the exact request bodies sent.

## Before you push

```sh
npm test
npm run check:skill
```

## Conventions

- **Conventional commits.** `feat:`, `fix:`, and `docs:` drive release-please. Anything else
  will not appear in the changelog.
- **Generated files are generated.** `skills/cloudflare-axi/SKILL.md` comes from `src/skill.js`
  via `npm run build:skill`. `CHANGELOG.md` and `.release-please-manifest.json` belong to
  release-please. A guard workflow fails PRs that hand-edit any of them.
- **Allow-list new fields.** Output schemas are allow-lists (`DETAIL_FIELDS` and friends). A
  new upstream field should stay out of default output unless it informs a decision.
- **Every mutation is idempotent or says why not.** If a command cannot be safely re-run,
  that belongs in a comment and in the command's `--help`.
- **Verify endpoints against the schema.** New paths and request bodies are checked against
  Cloudflare's published OpenAPI, not recalled. See [AGENTS.md](AGENTS.md).
- **Read [AGENTS.md](AGENTS.md) first.** It documents the traps that have already bitten,
  including the per-endpoint `per_page` caps that silently truncate listings.

## Releasing

Merging the release-please PR on `main` tags the release and publishes to npm. Publishing
requires an `NPM_TOKEN` repository secret. Verify afterwards with
`npm view cloudflare-axi version`.
