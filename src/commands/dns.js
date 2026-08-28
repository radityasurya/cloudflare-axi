import { AxiError } from "axi-sdk-js";
import { cf, cfList, dnsPageMax, resolveZone } from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, positiveInt, required, wantsHelp } from "../args.js";

const ID_RE = /^[0-9a-f]{32}$/i;
const PROXYABLE = new Set(["A", "AAAA", "CNAME"]);

/** `www` -> `www.example.com`; `@` or the bare apex -> `example.com`. */
export function fqdn(name, zoneName) {
  const lower = String(name).trim().toLowerCase().replace(/\.$/, "");
  if (!lower || lower === "@") return zoneName;
  if (lower === zoneName || lower.endsWith(`.${zoneName}`)) return lower;
  return `${lower}.${zoneName}`;
}

function row(record) {
  return {
    name: record.name,
    type: record.type,
    content: record.content,
    proxied: Boolean(record.proxied),
  };
}

const HELP = {
  list: helpFor({
    command: "dns list",
    description: "List DNS records in a zone",
    usage: `${BIN} dns list [--zone <name>] [--type <A|CNAME|...>] [--name <sub>] [--limit <n>]`,
    flags: {
      "--zone": "Zone to target (or CLOUDFLARE_ZONE; implied when the token sees one zone)",
      "--type": "Filter by record type",
      "--name": "Filter by record name (substring match)",
      "--content": "Filter by record content (substring match)",
      "--proxied": "Show only proxied records",
      "--limit": "Maximum records to return (default 200)",
    },
    examples: [`${BIN} dns list --zone example.com`, `${BIN} dns list --type A`],
  }),
  get: helpFor({
    command: "dns get",
    description: "Show every record matching one name",
    usage: `${BIN} dns get <name> [--type <type>] [--zone <name>]`,
    flags: { "--type": "Narrow to one record type" },
    examples: [`${BIN} dns get www`, `${BIN} dns get @ --type MX`],
  }),
  set: helpFor({
    command: "dns set",
    description: "Create or update a record (idempotent — re-running an identical set is a no-op)",
    usage: `${BIN} dns set <name> <type> <content> [--ttl <n>] [--proxied|--no-proxied] [--priority <n>]`,
    flags: {
      "--ttl": "TTL in seconds; 1 means automatic (default: 1 on create)",
      "--proxied": "Route through the Cloudflare proxy (A, AAAA, CNAME only)",
      "--no-proxied": "Serve DNS-only",
      "--priority": "Priority for MX and SRV records",
      "--comment": "Free-text comment stored on the record",
    },
    examples: [
      `${BIN} dns set www A 203.0.113.10 --proxied`,
      `${BIN} dns set @ MX mx.example.net --priority 10`,
    ],
  }),
  delete: helpFor({
    command: "dns delete",
    description: "Delete a record (idempotent — deleting an absent record is a no-op)",
    usage: `${BIN} dns delete <name|record-id> [--type <type>] [--zone <name>]`,
    flags: { "--type": "Narrow to one record type when a name has several" },
    examples: [`${BIN} dns delete old --type A`, `${BIN} dns delete ${"a".repeat(32)}`],
  }),
};

async function list(argv) {
  if (wantsHelp(argv)) return HELP.list;
  const { values } = parse(argv, {
    command: "dns list",
    flags: {
      type: { type: "string" },
      name: { type: "string" },
      content: { type: "string" },
      proxied: { type: "boolean" },
      limit: { type: "string" },
    },
  });
  const limit = positiveInt(values.limit, "--limit", 200);
  const zone = await resolveZone(values.zone);

  const { items, total } = await cfList(`/zones/${zone.id}/dns_records`, {
    limit,
    perPageMax: dnsPageMax,
    query: {
      type: values.type?.toUpperCase(),
      "name.contains": values.name,
      "content.contains": values.content,
      proxied: values.proxied ? "true" : undefined,
    },
  });

  if (total === 0) {
    const filtered = values.type || values.name || values.content || values.proxied;
    return {
      zone: zone.name,
      records: `0 records found in ${zone.name}${filtered ? " matching those filters" : ""}`,
      help: [`Run \`${BIN} dns set <name> <type> <content> --zone ${zone.name}\` to create one`],
    };
  }

  return {
    zone: zone.name,
    count: `${items.length} of ${total} total`,
    records: items.map(row),
    help: [
      `Run \`${BIN} dns get <name> --zone ${zone.name}\` for TTL, proxy, and record id`,
      `Run \`${BIN} dns set <name> <type> <content> --zone ${zone.name}\` to create or update`,
      ...(items.length < total
        ? [`Run \`${BIN} dns list --zone ${zone.name} --limit ${total}\` for all ${total}`]
        : []),
    ],
  };
}

/** Every record for one exact name, optionally narrowed by type. */
async function matching(zone, name, type) {
  const { items } = await cfList(`/zones/${zone.id}/dns_records`, {
    limit: 100,
    perPageMax: dnsPageMax,
    query: { "name.exact": fqdn(name, zone.name), type: type?.toUpperCase() },
  });
  return items;
}

async function get(argv) {
  if (wantsHelp(argv)) return HELP.get;
  const { values, positionals } = parse(argv, {
    command: "dns get",
    flags: { type: { type: "string" } },
  });
  const name = required(positionals[0], "<name>", "dns get", `${BIN} dns get www`);
  const zone = await resolveZone(values.zone);
  const records = await matching(zone, name, values.type);

  if (records.length === 0) {
    return {
      zone: zone.name,
      records: `0 records named ${fqdn(name, zone.name)}${values.type ? ` of type ${values.type.toUpperCase()}` : ""}`,
      help: [`Run \`${BIN} dns list --zone ${zone.name}\` to see what exists`],
    };
  }
  return {
    zone: zone.name,
    records: records.map((record) => ({
      ...row(record),
      ttl: record.ttl,
      priority: record.priority ?? "",
      id: record.id,
      comment: record.comment ?? "",
    })),
  };
}

function desiredFrom(values, content) {
  const desired = { content };
  if (values.ttl !== undefined) desired.ttl = positiveInt(values.ttl, "--ttl");
  if (values.proxied) desired.proxied = true;
  if (values["no-proxied"]) desired.proxied = false;
  if (values.priority !== undefined) desired.priority = positiveInt(values.priority, "--priority");
  if (values.comment !== undefined) desired.comment = values.comment;
  return desired;
}

async function set(argv) {
  if (wantsHelp(argv)) return HELP.set;
  const { values, positionals } = parse(argv, {
    command: "dns set",
    flags: {
      ttl: { type: "string" },
      proxied: { type: "boolean" },
      "no-proxied": { type: "boolean" },
      priority: { type: "string" },
      comment: { type: "string" },
    },
  });
  const [name, rawType, content] = positionals;
  required(name, "<name>", "dns set", `${BIN} dns set www A 203.0.113.10`);
  required(rawType, "<type>", "dns set", `${BIN} dns set www A 203.0.113.10`);
  required(content, "<content>", "dns set", `${BIN} dns set www A 203.0.113.10`);

  const type = rawType.toUpperCase();
  if (values.proxied && values["no-proxied"]) {
    throw new AxiError("--proxied and --no-proxied conflict", "VALIDATION_ERROR", [
      "Pass exactly one of --proxied or --no-proxied",
    ]);
  }
  if (values.proxied && !PROXYABLE.has(type)) {
    throw new AxiError(`${type} records can not be proxied`, "VALIDATION_ERROR", [
      `Only ${[...PROXYABLE].join(", ")} records support --proxied`,
    ]);
  }

  const zone = await resolveZone(values.zone);
  const target = fqdn(name, zone.name);
  const existing = await matching(zone, name, type);
  const desired = desiredFrom(values, content);

  if (existing.length > 1) {
    throw new AxiError(
      `${existing.length} ${type} records already exist for ${target}`,
      "VALIDATION_ERROR",
      [
        `Delete the ones you do not want with \`${BIN} dns delete <record-id> --zone ${zone.name}\``,
        ...existing.map((record) => `id ${record.id} -> ${record.content}`),
      ],
    );
  }

  if (existing.length === 0) {
    const { result } = await cf(`/zones/${zone.id}/dns_records`, {
      method: "POST",
      body: { name: target, type, ttl: 1, ...desired },
    });
    return {
      record: { ...row(result), ttl: result.ttl, id: result.id },
      created: true,
      help: [`Run \`${BIN} dns get ${name} --zone ${zone.name}\` to confirm`],
    };
  }

  const current = existing[0];
  const drift = Object.entries(desired).filter(([key, value]) => {
    const now = key === "proxied" ? Boolean(current[key]) : (current[key] ?? "");
    return now !== value;
  });
  if (drift.length === 0) {
    // AXI §6: the desired state already holds, so this is a no-op, not an error.
    return {
      record: { ...row(current), ttl: current.ttl, id: current.id },
      unchanged: true,
      note: `${target} ${type} already matches (no-op)`,
    };
  }

  const { result } = await cf(`/zones/${zone.id}/dns_records/${current.id}`, {
    method: "PATCH",
    body: desired,
  });
  return {
    record: { ...row(result), ttl: result.ttl, id: result.id },
    updated: drift.map(([key]) => key).join(" "),
  };
}

async function remove(argv) {
  if (wantsHelp(argv)) return HELP.delete;
  const { values, positionals } = parse(argv, {
    command: "dns delete",
    flags: { type: { type: "string" } },
  });
  const selector = required(
    positionals[0],
    "<name|record-id>",
    "dns delete",
    `${BIN} dns delete www --type A`,
  );
  const zone = await resolveZone(values.zone);

  let targets;
  if (ID_RE.test(selector)) {
    try {
      const { result } = await cf(`/zones/${zone.id}/dns_records/${selector}`);
      targets = [result];
    } catch (error) {
      if (error.code !== "API_ERROR" && error.code !== "NOT_FOUND") throw error;
      targets = [];
    }
  } else {
    targets = await matching(zone, selector, values.type);
  }

  if (targets.length === 0) {
    return {
      zone: zone.name,
      deleted: `no record matched ${selector} (already absent, no-op)`,
    };
  }
  if (targets.length > 1) {
    throw new AxiError(`${targets.length} records match ${selector}`, "VALIDATION_ERROR", [
      "Narrow with --type, or pass a record id",
      ...targets.map((record) => `id ${record.id} -> ${record.type} ${record.content}`),
    ]);
  }

  const [record] = targets;
  await cf(`/zones/${zone.id}/dns_records/${record.id}`, { method: "DELETE" });
  return { zone: zone.name, deleted: `${record.name} ${record.type} ${record.content}` };
}

export const dnsCommand = makeDispatcher(
  "dns",
  { list, get, set, delete: remove },
  {
    fallback: "list",
    summary: {
      list: "List DNS records in a zone",
      get: "Show every record matching one name",
      set: "Create or update a record (idempotent)",
      delete: "Delete a record (idempotent)",
    },
  },
);
