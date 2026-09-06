import { AxiError } from "axi-sdk-js";
import { cf, cfList, resolveAccountId, resolveZone } from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, positiveInt, required, wantsHelp } from "../args.js";

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
  create: helpFor({
    command: "zone create",
    description: "Add a domain to Cloudflare and print the nameservers to set at the registrar",
    usage: `${BIN} zone create <name> [--account <id>]`,
    flags: { "--account": "Account to create it under, when the token spans several" },
    examples: [`${BIN} zone create example.com`],
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

async function create(argv) {
  if (wantsHelp(argv)) return HELP.create;
  const { values, positionals } = parse(argv, { command: "zone create" });
  const name = required(positionals[0], "<name>", "zone create", `${BIN} zone create example.com`);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(name)) {
    throw new AxiError(`${name} is not a domain name`, "VALIDATION_ERROR", [
      "Pass the apex domain, without a scheme or path: `example.com`",
    ]);
  }

  // Adding a zone that is already on the account is the common re-run, and the
  // nameservers are the whole point of the output — so report them, not a 1061.
  const { items } = await cfList("/zones", { query: { name }, limit: 1 });
  if (items.length > 0) {
    const zone = items[0];
    return {
      zone: { name: zone.name, id: zone.id, status: zone.status },
      unchanged: true,
      nameservers: (zone.name_servers ?? []).join(" "),
      note: `${name} is already on this account (no-op)`,
    };
  }

  const account = await resolveAccountId({ accountId: values.account });
  const { result } = await cf("/zones", {
    method: "POST",
    body: { name, account: { id: account }, type: "full" },
  });
  return {
    zone: { name: result.name, id: result.id, status: result.status },
    created: true,
    nameservers: (result.name_servers ?? []).join(" "),
    help: [
      `Point the domain at those nameservers at its registrar, then \`${BIN} zone view ${name}\``,
      `The zone stays \`pending\` until Cloudflare sees the delegation`,
    ],
  };
}

export const zoneCommand = makeDispatcher(
  "zone",
  { list, view, create },
  {
    fallback: "list",
    summary: {
      list: "List the zones this token can see",
      view: "Show one zone with nameservers and record count",
      create: "Add a domain and print its nameservers",
    },
  },
);
