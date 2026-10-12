import { AxiError } from "axi-sdk-js";
import { cf, cfList, resolveAccountId, resolveZone } from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, required, wantsHelp } from "../args.js";

const TLS_VERSIONS = ["1.0", "1.1", "1.2", "1.3"];

const HELP = {
  list: helpFor({
    command: "r2 list",
    description: "R2 buckets on the account",
    usage: `${BIN} r2 list [--account <id>]`,
    examples: [`${BIN} r2 list`],
  }),
  get: helpFor({
    command: "r2 get",
    description: "One R2 bucket, plus its custom domains",
    usage: `${BIN} r2 get <bucket> [--account <id>]`,
    examples: [`${BIN} r2 get jala-assets`],
  }),
  "domain list": helpFor({
    command: "r2 domain list",
    description: "Custom domains attached to a bucket",
    usage: `${BIN} r2 domain list <bucket> [--account <id>]`,
    examples: [`${BIN} r2 domain list jala-assets`],
  }),
  "domain add": helpFor({
    command: "r2 domain add",
    description: "Attach a custom domain to a bucket (idempotent)",
    usage: `${BIN} r2 domain add <bucket> <domain> [--zone <name|id>] [--min-tls <version>]`,
    flags: {
      "--zone": "Zone that holds the domain (default: the domain's registrable zone)",
      "--min-tls": `Minimum TLS version: ${TLS_VERSIONS.join(", ")}`,
    },
    examples: [`${BIN} r2 domain add jala-assets assets.example.com --min-tls 1.2`],
  }),
  "domain remove": helpFor({
    command: "r2 domain remove",
    description: "Detach a custom domain from a bucket (no-op when absent)",
    usage: `${BIN} r2 domain remove <bucket> <domain> [--account <id>]`,
    examples: [`${BIN} r2 domain remove jala-assets assets.example.com`],
  }),
};

/** A 401/403 from an R2 endpoint means the token lacks the R2 permission. */
async function r2(path, options, write = false) {
  try {
    return await cf(path, options);
  } catch (error) {
    if (error.code !== "AUTH_ERROR") throw error;
    const need = write ? "Workers R2 Storage: Edit" : "Workers R2 Storage: Read";
    throw new AxiError(`The token is not allowed to use R2 (${error.message})`, "AUTH_ERROR", [
      `Grant the token Account → ${need} at https://dash.cloudflare.com/profile/api-tokens`,
    ]);
  }
}

const bucketPath = (accountId, bucket) =>
  `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}`;

function domainRow(d) {
  return {
    domain: d.domain,
    zone: d.zoneName ?? d.zoneId,
    status: d.status ? `ownership ${d.status.ownership}, ssl ${d.status.ssl}` : undefined,
    enabled: d.enabled,
    min_tls: d.minTLS ?? "1.0",
  };
}

async function domainsOf(accountId, bucket) {
  const { result } = await r2(`${bucketPath(accountId, bucket)}/domains/custom`);
  return result?.domains ?? [];
}

async function list(argv) {
  if (wantsHelp(argv)) return HELP.list;
  const { values } = parse(argv, { command: "r2 list" });
  const accountId = await resolveAccountId({ accountId: values.account });
  // R2 returns { buckets: [...] } and pages by cursor; 1000 is the per_page cap.
  const { result } = await r2(`/accounts/${accountId}/r2/buckets`, { query: { per_page: 1000 } });
  const buckets = result?.buckets ?? [];
  if (buckets.length === 0) return { buckets: "0 R2 buckets on this account" };
  return {
    count: `${buckets.length} total`,
    buckets: buckets.map((b) => ({
      name: b.name,
      location: b.location,
      created: b.creation_date,
    })),
    help: [`Run \`${BIN} r2 get <bucket>\` for a bucket and its custom domains`],
  };
}

async function get(argv) {
  if (wantsHelp(argv)) return HELP.get;
  const { values, positionals } = parse(argv, { command: "r2 get" });
  const bucket = required(positionals[0], "<bucket>", "r2 get", `${BIN} r2 get jala-assets`);
  const accountId = await resolveAccountId({ accountId: values.account });
  const { result } = await r2(bucketPath(accountId, bucket));
  const domains = await domainsOf(accountId, bucket);
  return {
    bucket: {
      name: result.name,
      location: result.location,
      storage_class: result.storage_class,
      created: result.creation_date,
    },
    domains: domains.length ? domains.map(domainRow) : "0 custom domains on this bucket",
    help: [`Run \`${BIN} r2 domain add ${bucket} <domain>\` to attach a custom domain`],
  };
}

async function domainList(argv) {
  if (wantsHelp(argv)) return HELP["domain list"];
  const { values, positionals } = parse(argv, { command: "r2 domain list" });
  const bucket = required(
    positionals[0],
    "<bucket>",
    "r2 domain list",
    `${BIN} r2 domain list jala-assets`,
  );
  const accountId = await resolveAccountId({ accountId: values.account });
  const domains = await domainsOf(accountId, bucket);
  if (domains.length === 0) {
    return {
      bucket,
      domains: "0 custom domains on this bucket",
      help: [`Run \`${BIN} r2 domain add ${bucket} <domain>\` to attach one`],
    };
  }
  return { bucket, count: `${domains.length} total`, domains: domains.map(domainRow) };
}

/** Try `a.b.example.com`, then `b.example.com`, then `example.com` as zone names. */
async function zoneForDomain(domain) {
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i += 1) {
    const name = labels.slice(i).join(".");
    const { items } = await cfList("/zones", { query: { name }, limit: 1 });
    if (items.length) return { id: items[0].id, name: items[0].name };
  }
  throw new AxiError(`No zone on this account holds ${domain}`, "NOT_FOUND", [
    "Pass `--zone <name|id>`, or run `cloudflare-axi zone list` to see available zones",
  ]);
}

async function domainAdd(argv) {
  if (wantsHelp(argv)) return HELP["domain add"];
  const { values, positionals } = parse(argv, {
    command: "r2 domain add",
    flags: { "min-tls": { type: "string" } },
  });
  const bucket = required(
    positionals[0],
    "<bucket>",
    "r2 domain add",
    `${BIN} r2 domain add jala-assets assets.example.com`,
  );
  const domain = required(
    positionals[1],
    "<domain>",
    "r2 domain add",
    `${BIN} r2 domain add ${bucket} assets.example.com`,
  ).toLowerCase();
  const minTls = values["min-tls"];
  if (minTls !== undefined && !TLS_VERSIONS.includes(minTls)) {
    throw new AxiError(`unsupported --min-tls ${minTls}`, "VALIDATION_ERROR", [
      `valid versions: ${TLS_VERSIONS.join(", ")}`,
    ]);
  }

  const accountId = await resolveAccountId({ accountId: values.account });
  const existing = (await domainsOf(accountId, bucket)).find((d) => d.domain === domain);
  if (existing) {
    return {
      bucket,
      domain: domainRow(existing),
      unchanged: true,
      note: `${domain} is already attached to ${bucket} (no-op)`,
    };
  }

  const zone = values.zone ? await resolveZone(values.zone) : await zoneForDomain(domain);
  const { result } = await r2(
    `${bucketPath(accountId, bucket)}/domains/custom`,
    {
      method: "POST",
      body: { domain, zoneId: zone.id, enabled: true, ...(minTls ? { minTLS: minTls } : {}) },
    },
    true,
  );
  return {
    bucket,
    domain: domainRow({ ...result, zoneName: zone.name }),
    created: true,
    help: [`Run \`${BIN} r2 domain list ${bucket}\` to watch ownership and ssl become active`],
  };
}

async function domainRemove(argv) {
  if (wantsHelp(argv)) return HELP["domain remove"];
  const { values, positionals } = parse(argv, { command: "r2 domain remove" });
  const bucket = required(
    positionals[0],
    "<bucket>",
    "r2 domain remove",
    `${BIN} r2 domain remove jala-assets assets.example.com`,
  );
  const domain = required(
    positionals[1],
    "<domain>",
    "r2 domain remove",
    `${BIN} r2 domain remove ${bucket} assets.example.com`,
  ).toLowerCase();
  const accountId = await resolveAccountId({ accountId: values.account });
  const existing = (await domainsOf(accountId, bucket)).find((d) => d.domain === domain);
  if (!existing) {
    return { bucket, removed: `${domain} is not attached to ${bucket} (no-op)` };
  }
  await r2(
    `${bucketPath(accountId, bucket)}/domains/custom/${encodeURIComponent(domain)}`,
    { method: "DELETE" },
    true,
  );
  return { bucket, removed: domainRow(existing) };
}

const domainCommand = makeDispatcher(
  "r2 domain",
  { list: domainList, add: domainAdd, remove: domainRemove },
  {
    fallback: "list",
    summary: {
      list: "Custom domains on a bucket",
      add: "Attach a custom domain",
      remove: "Detach a custom domain",
    },
  },
);

export const r2Command = makeDispatcher(
  "r2",
  { list, get, domain: domainCommand },
  {
    fallback: "list",
    summary: {
      list: "R2 buckets on the account",
      get: "One bucket and its custom domains",
      domain: "list, add, remove custom domains",
    },
  },
);
