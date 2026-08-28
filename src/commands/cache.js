import { AxiError } from "axi-sdk-js";
import { cf, resolveZone } from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, wantsHelp } from "../args.js";

const HELP = helpFor({
  command: "cache purge",
  description: "Purge the Cloudflare edge cache for a zone",
  usage: `${BIN} cache purge (--all | --url <u>... | --host <h>... | --prefix <p>... | --tag <t>...)`,
  flags: {
    "--all": "Purge everything in the zone",
    "--url": "Purge one exact URL (repeatable)",
    "--host": "Purge everything for a hostname (repeatable)",
    "--prefix": "Purge everything under a URL prefix (repeatable)",
    "--tag": "Purge by Cache-Tag (repeatable, Enterprise only)",
    "--zone": "Zone to target",
  },
  examples: [
    `${BIN} cache purge --all --zone example.com`,
    `${BIN} cache purge --url https://example.com/style.css --url https://example.com/app.js`,
  ],
});

// Cloudflare accepts exactly one purge selector per call.
const SELECTORS = [
  ["url", "files"],
  ["host", "hosts"],
  ["prefix", "prefixes"],
  ["tag", "tags"],
];

async function purge(argv) {
  if (wantsHelp(argv)) return HELP;
  const { values } = parse(argv, {
    command: "cache purge",
    flags: {
      all: { type: "boolean" },
      url: { type: "string", multiple: true },
      host: { type: "string", multiple: true },
      prefix: { type: "string", multiple: true },
      tag: { type: "string", multiple: true },
    },
  });

  const chosen = SELECTORS.filter(([flag]) => values[flag]?.length);
  if (values.all && chosen.length > 0) {
    throw new AxiError("--all can not be combined with a targeted purge", "VALIDATION_ERROR", [
      "Pass --all on its own, or drop it and keep the targeted flags",
    ]);
  }
  if (chosen.length > 1) {
    throw new AxiError("Cloudflare accepts one purge selector per call", "VALIDATION_ERROR", [
      `Purge ${chosen.map(([flag]) => `--${flag}`).join(" and ")} in separate calls`,
    ]);
  }
  if (!values.all && chosen.length === 0) {
    throw new AxiError("nothing to purge", "VALIDATION_ERROR", [
      `Pass --all, or target with --url/--host/--prefix/--tag`,
      `Run \`${BIN} cache purge --help\``,
    ]);
  }

  const zone = await resolveZone(values.zone);
  const [flag, field] = chosen[0] ?? [];
  const body = values.all ? { purge_everything: true } : { [field]: values[flag] };
  await cf(`/zones/${zone.id}/purge_cache`, { method: "POST", body });

  return {
    zone: zone.name,
    purged: values.all ? "everything" : `${values[flag].length} ${field}`,
    ...(values.all ? {} : { targets: values[flag] }),
    note: "Cloudflare purges asynchronously; edges clear within ~30s",
  };
}

export const cacheCommand = makeDispatcher(
  "cache",
  { purge },
  { summary: { purge: "Purge the edge cache for a zone" } },
);
