import { cf, cfList, resolveZone } from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, positiveInt, wantsHelp } from "../args.js";

const HELP = {
  list: helpFor({
    command: "zone list",
    description: "List the zones this token can see",
    usage: `${BIN} zone list [--limit <n>]`,
    flags: { "--limit": "Maximum zones to return (default 100)" },
    examples: [`${BIN} zone list`, `${BIN} zone list --limit 10`],
  }),
  view: helpFor({
    command: "zone view",
    description: "Show one zone with its nameservers and record count",
    usage: `${BIN} zone view [<name>] [--zone <name|id>]`,
    flags: { "--zone": "Zone to target when no positional name is given" },
    examples: [`${BIN} zone view example.com`, `${BIN} zone view --zone example.com`],
  }),
};

async function list(argv) {
  if (wantsHelp(argv)) return HELP.list;
  const { values } = parse(argv, { command: "zone list", flags: { limit: { type: "string" } } });
  const limit = positiveInt(values.limit, "--limit", 100);

  const { items, total } = await cfList("/zones", { limit });
  if (total === 0) {
    return {
      zones: "0 zones visible to this token",
      help: ["Check the token has Zone:Read at https://dash.cloudflare.com/profile/api-tokens"],
    };
  }
  return {
    count: `${items.length} of ${total} total`,
    zones: items.map((zone) => ({
      name: zone.name,
      status: zone.status,
      plan: zone.plan?.name ?? "unknown",
      paused: Boolean(zone.paused),
    })),
    help: [
      `Run \`${BIN} zone view <name>\` for nameservers and record count`,
      `Run \`${BIN} dns list --zone <name>\` to see a zone's records`,
      ...(items.length < total ? [`Run \`${BIN} zone list --limit ${total}\` for all ${total}`] : []),
    ],
  };
}

async function view(argv) {
  if (wantsHelp(argv)) return HELP.view;
  const { values, positionals } = parse(argv, { command: "zone view" });
  const zone = await resolveZone(positionals[0] ?? values.zone);

  const [{ result: detail }, records] = await Promise.all([
    cf(`/zones/${zone.id}`),
    // per_page=1 buys the total without pulling every record.
    cf(`/zones/${zone.id}/dns_records`, { query: { per_page: 1 } }),
  ]);

  return {
    zone: {
      name: detail.name,
      id: detail.id,
      status: detail.status,
      plan: detail.plan?.name ?? "unknown",
      paused: Boolean(detail.paused),
      records: records.result_info?.total_count ?? 0,
      nameservers: (detail.name_servers ?? []).join(" "),
    },
  };
}

export const zoneCommand = makeDispatcher(
  "zone",
  { list, view },
  {
    fallback: "list",
    summary: {
      list: "List the zones this token can see",
      view: "Show one zone with nameservers and record count",
    },
  },
);
