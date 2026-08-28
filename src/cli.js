import { runAxiCli } from "axi-sdk-js";
// The SDK renders command output itself but does not re-export its encoder,
// so the static top-level help encodes through the same official TOON library.
import { encode } from "@toon-format/toon";
import { cfList } from "./api.js";
import { BIN } from "./args.js";
import { cacheCommand } from "./commands/cache.js";
import { dnsCommand } from "./commands/dns.js";
import { emailCommand } from "./commands/email.js";
import { setupCommand } from "./commands/setup.js";
import { zoneCommand } from "./commands/zone.js";
import { VERSION } from "./version.js";

export const DESCRIPTION =
  "Manage Cloudflare zones, DNS records, edge cache, and Email Routing";

const HOME_ZONE_LIMIT = 10;

const TOP_LEVEL_HELP = `${encode({
  usage: `${BIN} [command] [args] [flags]`,
  commands: {
    "(none)": "dashboard — zones this token can see",
    zone: "list, view",
    dns: "list, get, set, delete",
    cache: "purge",
    email: "list, addresses, route, catch-all, delete",
    setup: "hooks, status, uninstall",
  },
  globals: {
    "--zone": "Target zone by name or id (or CLOUDFLARE_ZONE)",
    "--account": "Target account by id when the token spans several",
  },
  auth: "CLOUDFLARE_API_TOKEN (or CF_API_TOKEN)",
  examples: [
    `${BIN}`,
    `${BIN} dns list --zone example.com`,
    `${BIN} dns set www A 203.0.113.10 --proxied`,
    `${BIN} email route hi me@gmail.com`,
    `${BIN} cache purge --all`,
  ],
  help: [`Run \`${BIN} <command> --help\` for a command reference`],
})}\n`;

/**
 * AXI §8: no-args shows live state. With no token there is no live state to
 * show, so report that as data with a fix — not as a failure, since this view
 * is what a SessionStart hook runs on every session.
 */
async function home() {
  if (!process.env.CLOUDFLARE_API_TOKEN && !process.env.CF_API_TOKEN) {
    return {
      zones: "no Cloudflare API token in the environment",
      help: [
        "Create a scoped token at https://dash.cloudflare.com/profile/api-tokens",
        "Export it as CLOUDFLARE_API_TOKEN, then re-run",
      ],
    };
  }

  const { items, total } = await cfList("/zones", { limit: HOME_ZONE_LIMIT });
  if (total === 0) {
    return {
      zones: "0 zones visible to this token",
      help: ["Grant the token Zone:Read at https://dash.cloudflare.com/profile/api-tokens"],
    };
  }

  return {
    count: `${items.length} of ${total} total`,
    zones: items.map((zone) => ({
      name: zone.name,
      status: zone.status,
      plan: zone.plan?.name ?? "unknown",
    })),
    help: [
      `Run \`${BIN} dns list --zone <name>\` to see a zone's records`,
      `Run \`${BIN} dns set <name> <type> <content> --zone <name>\` to create or update a record`,
      `Run \`${BIN} email list --zone <name>\` for Email Routing rules`,
      `Run \`${BIN} cache purge --all --zone <name>\` to clear the edge cache`,
      ...(items.length < total ? [`Run \`${BIN} zone list --limit ${total}\` for all ${total}`] : []),
    ],
  };
}

export async function main() {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_LEVEL_HELP,
    home,
    commands: {
      zone: zoneCommand,
      dns: dnsCommand,
      cache: cacheCommand,
      email: emailCommand,
      setup: setupCommand,
    },
  });
}
