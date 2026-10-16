import { chmod, writeFile } from "node:fs/promises";
import { AxiError } from "axi-sdk-js";
import { cf, cfList, resolveAccountId } from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, required, wantsHelp } from "../args.js";

const MODES = ["managed", "non-interactive", "invisible"];
// Turnstile caps per_page at 25.
const PAGE = { perPageMax: 25 };

const HELP = {
  list: helpFor({
    command: "turnstile list",
    description: "List Turnstile widgets (name, sitekey, mode, domains; never the secret)",
    usage: `${BIN} turnstile list [--account <id>]`,
    examples: [`${BIN} turnstile list`],
  }),
  create: helpFor({
    command: "turnstile create",
    description: "Create a widget (idempotent by name). The secret is shown once by the API",
    usage: `${BIN} turnstile create <name> --domain <d> [--domain <d>...] [--mode ${MODES.join("|")}] [--secret-file <path>]`,
    flags: {
      "--domain": "Hostname the widget may run on (repeatable, required)",
      "--mode": `Widget mode: ${MODES.join(", ")} (default managed)`,
      "--secret-file": "Write SITEKEY=... and SECRET=... to this path with mode 600; print only the path",
    },
    examples: [`${BIN} turnstile create contact --domain example.com --secret-file .turnstile.env`],
  }),
  delete: helpFor({
    command: "turnstile delete",
    description: "Delete a widget by sitekey (no-op when absent)",
    usage: `${BIN} turnstile delete <sitekey> [--account <id>]`,
    examples: [`${BIN} turnstile delete 0x4AAAAAAAxxxx`],
  }),
};

const widgetRow = (w) => ({
  name: w.name,
  sitekey: w.sitekey,
  mode: w.mode,
  domains: (w.domains ?? []).join(" "),
});

const base = (accountId) => `/accounts/${accountId}/challenges/widgets`;

async function list(argv) {
  if (wantsHelp(argv)) return HELP.list;
  const { values } = parse(argv, { command: "turnstile list" });
  const accountId = await resolveAccountId({ accountId: values.account });
  const { items, total } = await cfList(base(accountId), { limit: 100, ...PAGE });
  if (total === 0) {
    return {
      widgets: "0 Turnstile widgets on this account",
      help: [`Run \`${BIN} turnstile create <name> --domain <d>\` to add one`],
    };
  }
  return { count: `${items.length} of ${total} total`, widgets: items.map(widgetRow) };
}

async function create(argv) {
  if (wantsHelp(argv)) return HELP.create;
  const { values, positionals } = parse(argv, {
    command: "turnstile create",
    flags: {
      domain: { type: "string", multiple: true },
      mode: { type: "string" },
      "secret-file": { type: "string" },
    },
  });
  const example = `${BIN} turnstile create contact --domain example.com`;
  const name = required(positionals[0], "<name>", "turnstile create", example);
  const domains = values.domain ?? [];
  if (domains.length === 0) {
    throw new AxiError("--domain is required", "VALIDATION_ERROR", [example]);
  }
  const mode = values.mode ?? "managed";
  if (!MODES.includes(mode)) {
    throw new AxiError(`unknown mode ${mode}`, "VALIDATION_ERROR", [`Pass one of: ${MODES.join(", ")}`]);
  }

  const accountId = await resolveAccountId({ accountId: values.account });
  const { items } = await cfList(base(accountId), { limit: 100, ...PAGE });
  const existing = items.find((w) => w.name === name);
  if (existing) {
    return {
      widget: widgetRow(existing),
      unchanged: true,
      note: `a widget named ${name} already exists (no-op); the secret is not retrievable`,
      help: [`Run \`${BIN} turnstile delete ${existing.sitekey}\` and create again to get a new secret`],
    };
  }

  const { result } = await cf(base(accountId), { method: "POST", body: { name, domains, mode } });
  const out = { widget: widgetRow(result), created: true };

  const file = values["secret-file"];
  if (file) {
    await writeFile(file, `SITEKEY=${result.sitekey}\nSECRET=${result.secret}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    return { ...out, secret_file: file };
  }
  return {
    ...out,
    note: "the secret is shown once and was not printed; delete this widget and rerun with --secret-file <path>, or rotate the secret in the dashboard",
  };
}

async function remove(argv) {
  if (wantsHelp(argv)) return HELP.delete;
  const { values, positionals } = parse(argv, { command: "turnstile delete" });
  const sitekey = required(positionals[0], "<sitekey>", "turnstile delete", `${BIN} turnstile delete 0x4AAA...`);
  const accountId = await resolveAccountId({ accountId: values.account });
  const { items } = await cfList(base(accountId), { limit: 100, ...PAGE });
  const target = items.find((w) => w.sitekey === sitekey);
  if (!target) return { deleted: `no widget with sitekey ${sitekey} (already absent, no-op)` };
  await cf(`${base(accountId)}/${encodeURIComponent(sitekey)}`, { method: "DELETE" });
  return { deleted: target.name, sitekey };
}

export const turnstileCommand = makeDispatcher(
  "turnstile",
  { list, create, delete: remove },
  {
    fallback: "list",
    summary: {
      list: "List widgets (never prints secrets)",
      create: "Create a widget; secret goes to --secret-file only",
      delete: "Delete a widget by sitekey (idempotent)",
    },
  },
);
