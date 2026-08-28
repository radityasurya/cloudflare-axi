import { AxiError } from "axi-sdk-js";
import { cf, cfList, resolveAccountId, resolveZone } from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, positiveInt, required, wantsHelp } from "../args.js";

const RULE_ID_RE = /^[0-9a-f]{32}$/i;

/** `hi` -> `hi@example.com`; a full address passes through. */
export function address(value, zoneName) {
  const lower = String(value).trim().toLowerCase();
  return lower.includes("@") ? lower : `${lower}@${zoneName}`;
}

function ruleRow(rule) {
  const action = rule.actions?.[0] ?? {};
  return {
    from: rule.matchers?.[0]?.value ?? "(catch-all)",
    action: action.type ?? "unknown",
    to: (action.value ?? []).join(" "),
    enabled: Boolean(rule.enabled),
  };
}

const HELP = {
  list: helpFor({
    command: "email list",
    description: "List Email Routing rules for a zone, with routing status and catch-all",
    usage: `${BIN} email list [--zone <name>] [--limit <n>]`,
    flags: { "--limit": "Maximum rules to return (default 100)" },
    examples: [`${BIN} email list --zone example.com`],
  }),
  addresses: helpFor({
    command: "email addresses",
    description: "List account destination addresses and whether they are verified",
    usage: `${BIN} email addresses [--account <id>]`,
    examples: [`${BIN} email addresses`],
  }),
  route: helpFor({
    command: "email route",
    description: "Forward an address to one or more destinations (idempotent)",
    usage: `${BIN} email route <from> <to> [<to>...] [--disabled] [--zone <name>]`,
    flags: { "--disabled": "Create or update the rule in a disabled state" },
    examples: [
      `${BIN} email route hi me@gmail.com`,
      `${BIN} email route support@example.com a@gmail.com b@gmail.com`,
    ],
  }),
  "catch-all": helpFor({
    command: "email catch-all",
    description: "Point every unmatched address at a destination, or drop it",
    usage: `${BIN} email catch-all (<to> | --drop) [--zone <name>]`,
    flags: { "--drop": "Silently discard unmatched mail instead of forwarding" },
    examples: [`${BIN} email catch-all me@gmail.com`, `${BIN} email catch-all --drop`],
  }),
  delete: helpFor({
    command: "email delete",
    description: "Delete a routing rule (idempotent)",
    usage: `${BIN} email delete <from|rule-id> [--zone <name>]`,
    examples: [`${BIN} email delete hi`],
  }),
};

async function routingStatus(zoneId) {
  try {
    const { result } = await cf(`/zones/${zoneId}/email/routing`);
    return result?.enabled ? "enabled" : (result?.status ?? "disabled");
  } catch {
    // Email Routing has never been enabled on this zone, or the token lacks the
    // read scope — neither should sink the whole listing.
    return "unavailable";
  }
}

async function catchAllRule(zoneId) {
  try {
    const { result } = await cf(`/zones/${zoneId}/email/routing/rules/catch_all`);
    return result;
  } catch {
    return undefined;
  }
}

async function list(argv) {
  if (wantsHelp(argv)) return HELP.list;
  const { values } = parse(argv, { command: "email list", flags: { limit: { type: "string" } } });
  const limit = positiveInt(values.limit, "--limit", 100);
  const zone = await resolveZone(values.zone);

  const [status, catchAll, rules] = await Promise.all([
    routingStatus(zone.id),
    catchAllRule(zone.id),
    cfList(`/zones/${zone.id}/email/routing/rules`, { limit }),
  ]);

  const catchAllAction = catchAll?.actions?.[0];
  const summary = {
    zone: zone.name,
    routing: status,
    "catch-all": catchAllAction
      ? `${catchAllAction.type}${catchAllAction.value?.length ? ` -> ${catchAllAction.value.join(" ")}` : ""}${catchAll.enabled ? "" : " (disabled)"}`
      : "not configured",
  };

  if (rules.total === 0) {
    return {
      ...summary,
      rules: `0 routing rules on ${zone.name}`,
      help: [
        `Run \`${BIN} email route <from> <to> --zone ${zone.name}\` to forward an address`,
        ...(status === "unavailable"
          ? [`Enable Email Routing for ${zone.name} in the Cloudflare dashboard first`]
          : []),
      ],
    };
  }

  return {
    ...summary,
    count: `${rules.items.length} of ${rules.total} total`,
    rules: rules.items.map(ruleRow),
    help: [
      `Run \`${BIN} email route <from> <to> --zone ${zone.name}\` to add or change a rule`,
      `Run \`${BIN} email addresses\` to check destinations are verified`,
    ],
  };
}

async function addresses(argv) {
  if (wantsHelp(argv)) return HELP.addresses;
  const { values } = parse(argv, { command: "email addresses" });
  const accountId = await resolveAccountId({ accountId: values.account });
  const { items, total } = await cfList(`/accounts/${accountId}/email/routing/addresses`, {
    limit: 100,
  });

  if (total === 0) {
    return {
      addresses: "0 destination addresses on this account",
      help: ["Add a destination in the Cloudflare dashboard; it must be verified before it can receive forwarded mail"],
    };
  }
  return {
    count: `${items.length} of ${total} total`,
    addresses: items.map((entry) => ({
      email: entry.email,
      verified: Boolean(entry.verified),
    })),
  };
}

/** Unverified destinations accept the rule but silently never deliver. */
async function unverified(destinations, accountId) {
  try {
    const { items } = await cfList(`/accounts/${accountId}/email/routing/addresses`, { limit: 100 });
    const verified = new Set(items.filter((e) => e.verified).map((e) => e.email.toLowerCase()));
    return destinations.filter((to) => !verified.has(to));
  } catch {
    return [];
  }
}

async function route(argv) {
  if (wantsHelp(argv)) return HELP.route;
  const { values, positionals } = parse(argv, {
    command: "email route",
    flags: { disabled: { type: "boolean" } },
  });
  const from = required(positionals[0], "<from>", "email route", `${BIN} email route hi me@gmail.com`);
  if (positionals.length < 2) {
    throw new AxiError("<to> is required", "VALIDATION_ERROR", [
      `${BIN} email route ${from} me@gmail.com`,
    ]);
  }

  const zone = await resolveZone(values.zone);
  const source = address(from, zone.name);
  const destinations = positionals.slice(1).map((to) => address(to, zone.name));
  const enabled = !values.disabled;

  const { items } = await cfList(`/zones/${zone.id}/email/routing/rules`, { limit: 200 });
  const existing = items.find((rule) => rule.matchers?.[0]?.value?.toLowerCase() === source);

  const body = {
    name: `forward ${source}`,
    enabled,
    matchers: [{ type: "literal", field: "to", value: source }],
    actions: [{ type: "forward", value: destinations }],
  };

  let result;
  let outcome;
  if (!existing) {
    ({ result } = await cf(`/zones/${zone.id}/email/routing/rules`, { method: "POST", body }));
    outcome = { created: true };
  } else {
    const current = existing.actions?.[0]?.value ?? [];
    const same =
      Boolean(existing.enabled) === enabled &&
      current.length === destinations.length &&
      current.every((to, index) => to.toLowerCase() === destinations[index]);
    if (same) {
      return {
        rule: ruleRow(existing),
        unchanged: true,
        note: `${source} already forwards there (no-op)`,
      };
    }
    ({ result } = await cf(`/zones/${zone.id}/email/routing/rules/${existing.tag ?? existing.id}`, {
      method: "PUT",
      body,
    }));
    outcome = { updated: true };
  }

  const accountId = await resolveAccountId({ accountId: values.account }).catch(() => undefined);
  const pending = accountId ? await unverified(destinations, accountId) : [];

  return {
    rule: ruleRow(result),
    ...outcome,
    ...(pending.length
      ? {
          warning: `${pending.join(" ")} not verified — mail will not be delivered until verified`,
          help: [`Run \`${BIN} email addresses\` and confirm the verification email`],
        }
      : {}),
  };
}

async function catchAll(argv) {
  if (wantsHelp(argv)) return HELP["catch-all"];
  const { values, positionals } = parse(argv, {
    command: "email catch-all",
    flags: { drop: { type: "boolean" } },
  });
  if (values.drop && positionals.length > 0) {
    throw new AxiError("--drop takes no destination", "VALIDATION_ERROR", [
      `Pass either a destination or --drop, not both`,
    ]);
  }
  if (!values.drop && positionals.length === 0) {
    throw new AxiError("a destination or --drop is required", "VALIDATION_ERROR", [
      `${BIN} email catch-all me@gmail.com`,
      `${BIN} email catch-all --drop`,
    ]);
  }

  const zone = await resolveZone(values.zone);
  const destinations = positionals.map((to) => address(to, zone.name));
  const action = values.drop ? { type: "drop" } : { type: "forward", value: destinations };

  const { result } = await cf(`/zones/${zone.id}/email/routing/rules/catch_all`, {
    method: "PUT",
    body: {
      name: "catch-all",
      enabled: true,
      matchers: [{ type: "all" }],
      actions: [action],
    },
  });

  return {
    zone: zone.name,
    "catch-all": values.drop ? "drop" : `forward -> ${destinations.join(" ")}`,
    enabled: Boolean(result?.enabled ?? true),
  };
}

async function remove(argv) {
  if (wantsHelp(argv)) return HELP.delete;
  const { values, positionals } = parse(argv, { command: "email delete" });
  const selector = required(
    positionals[0],
    "<from|rule-id>",
    "email delete",
    `${BIN} email delete hi`,
  );
  const zone = await resolveZone(values.zone);

  const { items } = await cfList(`/zones/${zone.id}/email/routing/rules`, { limit: 200 });
  const source = address(selector, zone.name);
  const target = RULE_ID_RE.test(selector)
    ? items.find((rule) => (rule.tag ?? rule.id) === selector)
    : items.find((rule) => rule.matchers?.[0]?.value?.toLowerCase() === source);

  if (!target) {
    return { zone: zone.name, deleted: `no rule matched ${selector} (already absent, no-op)` };
  }
  await cf(`/zones/${zone.id}/email/routing/rules/${target.tag ?? target.id}`, { method: "DELETE" });
  return { zone: zone.name, deleted: ruleRow(target).from };
}

export const emailCommand = makeDispatcher(
  "email",
  { list, addresses, route, "catch-all": catchAll, delete: remove },
  {
    fallback: "list",
    summary: {
      list: "List routing rules, status, and catch-all",
      addresses: "List account destination addresses and verification state",
      route: "Forward an address to destinations (idempotent)",
      "catch-all": "Set the catch-all destination, or drop",
      delete: "Delete a routing rule (idempotent)",
    },
  },
);
