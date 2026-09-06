import { AxiError } from "axi-sdk-js";
import { cf, resolveZone } from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, required, wantsHelp } from "../args.js";

// Redirect Rules live in the zone's dynamic-redirect phase entrypoint ruleset.
const PHASE = "http_request_dynamic_redirect";
const STATUS_CODES = [301, 302, 303, 307, 308];
const ID_RE = /^[0-9a-f]{32}$/i;

const HELP = {
  list: helpFor({
    command: "redirect list",
    description: "Redirect rules on a zone, in the order Cloudflare evaluates them",
    usage: `${BIN} redirect list [--zone <name>]`,
    examples: [`${BIN} redirect list --zone example.com`],
  }),
  set: helpFor({
    command: "redirect set",
    description: "Send matching requests to another URL (idempotent on the match expression)",
    usage: `${BIN} redirect set <target-url> [--when <expression>] [--status <code>] [--zone <name>]`,
    flags: {
      "--when": 'Cloudflare filter expression to match (default `true`, the whole zone)',
      "--status": `Redirect status: ${STATUS_CODES.join(", ")} (default 301)`,
      "--no-path": "Send every request to the bare target instead of preserving the path",
      "--no-query": "Drop the query string instead of preserving it",
      "--description": "Label for the rule (default derived from the target)",
    },
    examples: [
      `${BIN} redirect set https://new.example --zone old.example`,
      `${BIN} redirect set https://new.example// --no-path --status 302 --zone old.example`,
      `${BIN} redirect set https://new.example --when 'http.request.uri.path contains "/blog"'`,
    ],
  }),
  delete: helpFor({
    command: "redirect delete",
    description: "Remove one redirect rule by id or description",
    usage: `${BIN} redirect delete <id|description> [--zone <name>]`,
    examples: [`${BIN} redirect delete "redirect to https://new.example"`],
  }),
};

/** The phase entrypoint 404s until a zone has its first redirect rule. */
async function entrypoint(zone) {
  try {
    const { result } = await cf(`/zones/${zone.id}/rulesets/phases/${PHASE}/entrypoint`);
    return { id: result.id, rules: result.rules ?? [] };
  } catch (error) {
    if (error.code === "API_ERROR" || error.code === "NOT_FOUND") return { id: null, rules: [] };
    throw error;
  }
}

/**
 * Cloudflare replaces the whole ruleset on write, so every mutation sends the
 * full list back. Anything omitted here would be silently deleted.
 */
async function putRules(zone, rules) {
  const { result } = await cf(`/zones/${zone.id}/rulesets/phases/${PHASE}/entrypoint`, {
    method: "PUT",
    body: { rules },
  });
  return result.rules ?? [];
}

function row(rule) {
  const from = rule.action_parameters?.from_value ?? {};
  return {
    id: rule.id,
    when: rule.expression,
    to: from.target_url?.expression ?? from.target_url?.value ?? "",
    status: from.status_code,
    ...(rule.enabled === false ? { enabled: false } : {}),
  };
}

async function list(argv) {
  if (wantsHelp(argv)) return HELP.list;
  const { values } = parse(argv, { command: "redirect list" });
  const zone = await resolveZone(values.zone);
  const { rules } = await entrypoint(zone);

  if (rules.length === 0) {
    return {
      zone: zone.name,
      redirects: "0 redirect rules on this zone",
      help: [`Run \`${BIN} redirect set <target-url> --zone ${zone.name}\` to add one`],
    };
  }
  return { zone: zone.name, count: `${rules.length} total`, redirects: rules.map(row) };
}

async function set(argv) {
  if (wantsHelp(argv)) return HELP.set;
  const { values, positionals } = parse(argv, {
    command: "redirect set",
    flags: {
      when: { type: "string" },
      status: { type: "string" },
      "no-path": { type: "boolean" },
      "no-query": { type: "boolean" },
      description: { type: "string" },
    },
  });
  const target = required(
    positionals[0],
    "<target-url>",
    "redirect set",
    `${BIN} redirect set https://new.example --zone old.example`,
  );

  // A malformed target does not fail the API call — it silently redirects every
  // visitor to a broken URL, so it is checked before the zone is touched.
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw new AxiError(`target ${target} is not an absolute URL`, "VALIDATION_ERROR", [
      `Include the scheme: ${BIN} redirect set https://${target.replace(/^\/+/, "")}`,
    ]);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AxiError(`target ${target} is not http(s)`, "VALIDATION_ERROR", [
      "A redirect target must be an http:// or https:// URL",
    ]);
  }

  const status = values.status === undefined ? 301 : Number(values.status);
  if (!STATUS_CODES.includes(status)) {
    throw new AxiError(`unsupported redirect status ${values.status}`, "VALIDATION_ERROR", [
      `valid statuses: ${STATUS_CODES.join(", ")}`,
    ]);
  }

  const expression = values.when || "true";
  const base = target.replace(/\/+$/, "");
  const from_value = {
    status_code: status,
    preserve_query_string: !values["no-query"],
    target_url: values["no-path"]
      ? { value: target }
      : { expression: `concat(${JSON.stringify(base)}, http.request.uri.path)` },
  };
  const desired = {
    action: "redirect",
    action_parameters: { from_value },
    expression,
    description: values.description || `redirect to ${target}`,
  };

  const zone = await resolveZone(values.zone);
  const { rules } = await entrypoint(zone);
  // One rule per match expression: re-running with a new target retargets the
  // existing rule instead of stacking a second, unreachable one behind it.
  const index = rules.findIndex((rule) => rule.expression === expression);

  if (index === -1) {
    const written = await putRules(zone, [...rules, desired]);
    return {
      zone: zone.name,
      redirect: row(written.at(-1) ?? desired),
      created: true,
      help: [`Run \`${BIN} redirect list --zone ${zone.name}\` to confirm`],
    };
  }

  const current = rules[index];
  const same =
    JSON.stringify(current.action_parameters?.from_value ?? {}) === JSON.stringify(from_value) &&
    current.action === "redirect";
  if (same) {
    return {
      zone: zone.name,
      redirect: row(current),
      unchanged: true,
      note: `a redirect for \`${expression}\` already matches (no-op)`,
    };
  }

  const next = rules.map((rule, at) =>
    at === index ? { ...rule, ...desired, id: undefined } : rule,
  );
  const written = await putRules(zone, next);
  return { zone: zone.name, redirect: row(written[index] ?? desired), updated: true };
}

async function remove(argv) {
  if (wantsHelp(argv)) return HELP.delete;
  const { values, positionals } = parse(argv, { command: "redirect delete" });
  const selector = required(
    positionals[0],
    "<id|description>",
    "redirect delete",
    `${BIN} redirect delete "redirect to https://new.example"`,
  );
  const zone = await resolveZone(values.zone);
  const { rules } = await entrypoint(zone);

  const matches = ID_RE.test(selector)
    ? rules.filter((rule) => rule.id === selector)
    : rules.filter((rule) => rule.description === selector || rule.expression === selector);

  if (matches.length === 0) {
    return {
      zone: zone.name,
      deleted: `no redirect rule matching ${selector} (no-op)`,
      ...(rules.length ? { present: rules.map((rule) => rule.description || rule.id) } : {}),
    };
  }
  if (matches.length > 1) {
    throw new AxiError(`${matches.length} redirect rules match ${selector}`, "VALIDATION_ERROR", [
      "Delete by rule id instead",
      ...matches.map((rule) => `Run \`${BIN} redirect delete ${rule.id} --zone ${zone.name}\``),
    ]);
  }

  const gone = matches[0];
  await putRules(zone, rules.filter((rule) => rule.id !== gone.id));
  return { zone: zone.name, deleted: row(gone) };
}

export const redirectCommand = makeDispatcher(
  "redirect",
  { list, set, delete: remove },
  {
    fallback: "list",
    summary: {
      list: "Redirect rules on a zone",
      set: "Send matching requests to another URL",
      delete: "Remove one redirect rule",
    },
  },
);
