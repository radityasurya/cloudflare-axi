import { AxiError } from "axi-sdk-js";
import { cf, resolveZone } from "../api.js";
import { BIN, helpFor, makeDispatcher, parse, required, wantsHelp } from "../args.js";

const WAF_PHASE = "http_request_firewall_custom";

// Settings that decide whether a non-browser client is challenged. The zone
// settings endpoint returns every setting; these are the ones that matter here.
const CHALLENGE_SETTINGS = ["security_level", "browser_check", "challenge_ttl"];

const HELP = {
  show: helpFor({
    command: "security show",
    description: "Bot protection, security level, and challenge-relevant settings for a zone",
    usage: `${BIN} security show [--zone <name>]`,
    examples: [`${BIN} security show --zone example.com`],
  }),
  rules: helpFor({
    command: "security rules",
    description: "Custom WAF rules, newest first",
    usage: `${BIN} security rules [--zone <name>]`,
    examples: [`${BIN} security rules --zone example.com`],
  }),
  check: helpFor({
    command: "security check",
    description:
      "Fetch a URL the way a non-browser client would and explain what, if anything, blocks it",
    usage: `${BIN} security check <url> [--zone <name>] [--user-agent <ua>]`,
    flags: { "--user-agent": "Send a specific User-Agent (default: a plain bot UA)" },
    examples: [
      `${BIN} security check https://example.com/`,
      `${BIN} security check https://example.com/ --user-agent GPTBot`,
    ],
  }),
};

/** Zone settings come back as a flat list; index it by setting id. */
async function settingsMap(zoneId, options) {
  const { result } = await cf(`/zones/${zoneId}/settings`, options);
  return Object.fromEntries((result ?? []).map((entry) => [entry.id, entry.value]));
}

/** Bot management needs its own token scope; a denial should not sink the view. */
async function botManagement(zoneId, options) {
  try {
    const { result } = await cf(`/zones/${zoneId}/bot_management`, options);
    return result ?? {};
  } catch {
    return undefined;
  }
}

async function wafRules(zoneId, options) {
  try {
    const { result } = await cf(`/zones/${zoneId}/rulesets/phases/${WAF_PHASE}/entrypoint`, options);
    return result?.rules ?? [];
  } catch {
    // No custom ruleset has ever been created on this zone.
    return [];
  }
}

/**
 * Name the bot-protection posture in one line. Free zones expose `fight_mode`;
 * paid zones expose the `sbfm_*` family, where "definitely automated" is what
 * catches curl and unbrowsered agents.
 */
function botPosture(bot) {
  if (!bot) return "unreadable (token lacks Bot Management read)";
  const on = [];
  if (bot.fight_mode) on.push("bot_fight_mode");
  if (bot.sbfm_definitely_automated && bot.sbfm_definitely_automated !== "allow") {
    on.push(`sbfm_definitely_automated=${bot.sbfm_definitely_automated}`);
  }
  if (bot.sbfm_likely_automated && bot.sbfm_likely_automated !== "allow") {
    on.push(`sbfm_likely_automated=${bot.sbfm_likely_automated}`);
  }
  if (bot.ai_bots_protection && bot.ai_bots_protection !== "disabled") {
    on.push(`ai_bots_protection=${bot.ai_bots_protection}`);
  }
  if (bot.crawler_protection && bot.crawler_protection !== "disabled") {
    on.push(`crawler_protection=${bot.crawler_protection}`);
  }
  return on.length ? on.join(" ") : "none active";
}

async function show(argv) {
  if (wantsHelp(argv)) return HELP.show;
  const { values } = parse(argv, { command: "security show" });
  const options = { env: process.env };
  const zone = await resolveZone(values.zone, options);

  const [settings, bot, rules] = await Promise.all([
    settingsMap(zone.id, options),
    botManagement(zone.id, options),
    wafRules(zone.id, options),
  ]);

  const blocking = rules.filter(
    (rule) => rule.enabled !== false && /challenge|block|managed_challenge|js_challenge/.test(rule.action ?? ""),
  );

  return {
    zone: zone.name,
    bots: botPosture(bot),
    settings: Object.fromEntries(
      CHALLENGE_SETTINGS.map((id) => [id, settings[id] ?? "unreadable"]),
    ),
    waf: `${rules.length} custom rules, ${blocking.length} that block or challenge`,
    help: [
      `Run \`${BIN} security check <url> --zone ${zone.name}\` to test what a non-browser client sees`,
      ...(rules.length ? [`Run \`${BIN} security rules --zone ${zone.name}\` to list the rules`] : []),
    ],
  };
}

async function rules(argv) {
  if (wantsHelp(argv)) return HELP.rules;
  const { values } = parse(argv, { command: "security rules" });
  const options = { env: process.env };
  const zone = await resolveZone(values.zone, options);
  const all = await wafRules(zone.id, options);

  if (all.length === 0) {
    return { zone: zone.name, rules: `0 custom WAF rules on ${zone.name}` };
  }
  return {
    zone: zone.name,
    count: `${all.length} total`,
    rules: all.map((rule) => ({
      action: rule.action ?? "-",
      enabled: rule.enabled !== false,
      description: rule.description || "-",
      expression: rule.expression ?? "-",
    })),
  };
}

/**
 * AXI §4: the expensive cost is the follow-up call. Probing the URL and reading
 * the zone's posture in one command turns a multi-request forensic session into
 * a single answer.
 */
async function check(argv) {
  if (wantsHelp(argv)) return HELP.check;
  const { values, positionals } = parse(argv, {
    command: "security check",
    flags: { "user-agent": { type: "string" } },
  });
  const url = required(
    positionals[0],
    "<url>",
    "security check",
    `${BIN} security check https://example.com/`,
  );
  if (!/^https?:\/\//i.test(url)) {
    throw new AxiError("<url> must start with http:// or https://", "VALIDATION_ERROR", [
      `${BIN} security check https://${url.replace(/^\/+/, "")}`,
    ]);
  }

  const agent = values["user-agent"] ?? `${BIN}/probe (non-browser client)`;
  let response;
  try {
    response = await fetch(url, { headers: { "user-agent": agent }, redirect: "manual" });
  } catch (cause) {
    throw new AxiError(`could not reach ${url}: ${cause.message}`, "NETWORK_ERROR", [
      "Check the hostname resolves and the origin is up",
    ]);
  }

  const mitigated = response.headers.get("cf-mitigated");
  const served = response.headers.get("server") ?? "";
  const probe = {
    url,
    status: response.status,
    server: served || "-",
    ...(mitigated ? { "cf-mitigated": mitigated } : {}),
  };

  // Only reach for zone config when the probe actually shows Cloudflare acting.
  const blocked = mitigated || response.status === 403 || response.status === 503;
  if (!blocked) {
    return {
      probe,
      verdict: "not blocked — a non-browser client can fetch this URL",
    };
  }

  let posture = {};
  try {
    const options = { env: process.env };
    const zone = await resolveZone(values.zone ?? new URL(url).hostname, options);
    const [settings, bot] = await Promise.all([
      settingsMap(zone.id, options),
      botManagement(zone.id, options),
    ]);
    posture = {
      zone: zone.name,
      bots: botPosture(bot),
      security_level: settings.security_level ?? "unreadable",
      browser_check: settings.browser_check ?? "unreadable",
    };
  } catch (error) {
    posture = { zone: `settings unreadable: ${error.message}` };
  }

  // Rank by explanatory power, most specific first. browser_check and
  // security_level are on for most zones including ones that serve bots fine,
  // so leading with either buries the setting that actually differs.
  const causes = [];
  const contributing = [];
  const botFlags = posture.bots ?? "";

  if (/ai_bots_protection=|crawler_protection=/.test(botFlags)) {
    causes.push(`AI/crawler blocking is on (${botFlags}) — it 403s known AI user-agents by name`);
  }
  if (/bot_fight_mode|sbfm_definitely_automated/.test(botFlags)) {
    causes.push(`bot protection scores this client as automated (${botFlags})`);
  }
  if (posture.security_level === "under_attack") {
    causes.push("security_level is under_attack, which challenges every visitor");
  }
  if (mitigated === "challenge" && causes.length === 0) {
    causes.push("Cloudflare is serving a JS challenge; clients without a JS engine can never pass");
  }
  if (posture.browser_check === "on") {
    contributing.push("browser_check is on (challenges requests whose headers look non-browser)");
  }
  if (posture.security_level && posture.security_level !== "under_attack") {
    contributing.push(`security_level is ${posture.security_level} (challenges above a threat score)`);
  }

  const fixes = [];
  if (/ai_bots_protection=|crawler_protection=/.test(botFlags)) {
    fixes.push("Security > Bots > Block AI Scrapers and Crawlers — turn it off to allow AI user-agents");
  }
  if (/bot_fight_mode|sbfm_/.test(botFlags)) {
    fixes.push("Security > Bots — turn off Bot Fight Mode, or set 'definitely automated' to Allow");
  }
  if (causes.length === 0) {
    fixes.push(`Run \`${BIN} security rules --zone ${posture.zone ?? "<zone>"}\` — a custom WAF rule may match`);
    fixes.push("A transient challenge can also come from the client IP's threat score; retry later to tell them apart");
  }
  fixes.push("Or add a WAF skip rule for the clients you want to allow");

  return {
    probe,
    ...posture,
    verdict: causes.length
      ? causes.join("; ")
      : "blocked, but no persistent zone setting explains it",
    ...(contributing.length ? { contributing: contributing.join("; ") } : {}),
    help: fixes,
  };
}

export const securityCommand = makeDispatcher(
  "security",
  { show, rules, check },
  {
    fallback: "show",
    summary: {
      show: "Bot protection, security level, and challenge settings",
      rules: "List custom WAF rules",
      check: "Probe a URL as a non-browser client and explain what blocks it",
    },
  },
);
