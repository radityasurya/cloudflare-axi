import test from "node:test";
import assert from "node:assert/strict";
import { securityCommand } from "../src/commands/security.js";
import { mockCloudflare, page, withToken, zone, zoneLookup } from "./helpers.js";

test.beforeEach(withToken);

const SETTINGS = {
  result: [
    { id: "security_level", value: "high" },
    { id: "browser_check", value: "on" },
    { id: "challenge_ttl", value: 1800 },
    { id: "always_use_https", value: "on" },
  ],
};

test("show names the active bot protections rather than dumping the payload", async () => {
  mockCloudflare({
    ...zoneLookup,
    [`GET /zones/${zone.id}/settings`]: SETTINGS,
    [`GET /zones/${zone.id}/bot_management`]: { fight_mode: true, ai_bots_protection: "block" },
    [`GET /zones/${zone.id}/rulesets/phases/http_request_firewall_custom/entrypoint`]: {
      rules: [{ action: "managed_challenge", enabled: true, expression: "true" }],
    },
  });
  const output = await securityCommand(["show", "--zone", "example.com"]);

  assert.match(output.bots, /bot_fight_mode/);
  assert.match(output.bots, /ai_bots_protection=block/);
  assert.equal(output.settings.security_level, "high");
  assert.match(output.waf, /1 custom rules, 1 that block or challenge/);
});

test("show degrades when the token cannot read bot management", async () => {
  mockCloudflare({
    ...zoneLookup,
    [`GET /zones/${zone.id}/settings`]: SETTINGS,
    // bot_management + ruleset routes deliberately absent -> 404 from the mock
  });
  const output = await securityCommand(["show", "--zone", "example.com"]);
  assert.match(output.bots, /unreadable/);
  assert.equal(output.settings.browser_check, "on");
});

test("check explains a JS challenge instead of just reporting 403", async () => {
  mockCloudflare({
    ...zoneLookup,
    "PROBE https://example.com/": {
      status: 403,
      headers: { "cf-mitigated": "challenge", server: "cloudflare" },
    },
    [`GET /zones/${zone.id}/settings`]: SETTINGS,
    [`GET /zones/${zone.id}/bot_management`]: { fight_mode: true },
  });
  const output = await securityCommand(["check", "https://example.com/", "--zone", "example.com"]);

  assert.equal(output.probe.status, 403);
  assert.equal(output.probe["cf-mitigated"], "challenge");
  // The verdict must lead with the setting that actually differs between zones.
  // browser_check and security_level are on almost everywhere, including zones
  // that serve bots fine, so they are contributing context — not the cause.
  assert.match(output.verdict, /bot_fight_mode/);
  assert.doesNotMatch(output.verdict, /browser_check/);
  assert.match(output.contributing, /browser_check/);
  assert.ok(
    output.help.some((h) => h.includes("Bot Fight Mode")),
    "the fix must name the control that is actually active",
  );
});

test("check reports success without touching zone settings when nothing blocks", async () => {
  const calls = mockCloudflare({
    "PROBE https://example.com/": { status: 200, headers: { server: "cloudflare" } },
  });
  const output = await securityCommand(["check", "https://example.com/"]);

  assert.match(output.verdict, /not blocked/);
  assert.equal(calls.length, 0, "a passing probe must not spend an API call");
});

test("check rejects a bare hostname before probing", async () => {
  mockCloudflare({});
  await assert.rejects(
    () => securityCommand(["check", "example.com"]),
    (error) =>
      error.code === "VALIDATION_ERROR" &&
      error.suggestions.some((s) => s.includes("https://example.com")),
  );
});

test("rules states the zero explicitly when no custom ruleset exists", async () => {
  mockCloudflare({ ...zoneLookup });
  const output = await securityCommand(["rules", "--zone", "example.com"]);
  assert.match(output.rules, /^0 custom WAF rules/);
});

test("an AI-blocking zone is diagnosed by name, not as a generic challenge", async () => {
  mockCloudflare({
    ...zoneLookup,
    "PROBE https://example.com/": { status: 403, headers: { server: "cloudflare" } },
    [`GET /zones/${zone.id}/settings`]: SETTINGS,
    [`GET /zones/${zone.id}/bot_management`]: { fight_mode: false, ai_bots_protection: "block" },
  });
  const output = await securityCommand(["check", "https://example.com/", "--zone", "example.com"]);

  assert.match(output.verdict, /AI\/crawler blocking is on/);
  assert.ok(
    output.help.some((h) => h.includes("Block AI Scrapers and Crawlers")),
    "the fix must point at the AI toggle, not Bot Fight Mode",
  );
  assert.ok(!output.help.some((h) => h.includes("Bot Fight Mode")));
});

const BOT = { fight_mode: true, enable_js: true, ai_bots_protection: "block", using_latest_model: true };
const BOT_URL = `/zones/${zone.id}/bot_management`;

test("bot-fight off keeps every other field and reports before and after", async () => {
  const calls = mockCloudflare({
    ...zoneLookup,
    [`GET ${BOT_URL}`]: BOT,
    [`PUT ${BOT_URL}`]: ({ body }) => body,
  });
  const output = await securityCommand(["bot-fight", "off", "--zone", "example.com"]);
  const put = calls.find((c) => c.method === "PUT");
  assert.deepEqual(put.body, { fight_mode: false, enable_js: true, ai_bots_protection: "block" });
  assert.equal(output.before, true);
  assert.equal(output.after, false);
});

test("bot-fight on when already on is a no-op", async () => {
  const calls = mockCloudflare({ ...zoneLookup, [`GET ${BOT_URL}`]: BOT });
  const output = await securityCommand(["bot-fight", "on", "--zone", "example.com"]);
  assert.equal(output.unchanged, true);
  assert.ok(!calls.some((c) => c.method === "PUT"));
});

test("js-detection toggles enable_js", async () => {
  const calls = mockCloudflare({
    ...zoneLookup,
    [`GET ${BOT_URL}`]: BOT,
    [`PUT ${BOT_URL}`]: ({ body }) => body,
  });
  await securityCommand(["js-detection", "off", "--zone", "example.com"]);
  assert.equal(calls.find((c) => c.method === "PUT").body.enable_js, false);
});

test("browser-check off patches the zone setting", async () => {
  const calls = mockCloudflare({
    ...zoneLookup,
    [`GET /zones/${zone.id}/settings`]: SETTINGS,
    [`PATCH /zones/${zone.id}/settings/browser_check`]: ({ body }) => ({ id: "browser_check", value: body.value }),
  });
  const output = await securityCommand(["browser-check", "off", "--zone", "example.com"]);
  assert.deepEqual(calls.find((c) => c.method === "PATCH").body, { value: "off" });
  assert.equal(output.before, "on");
  assert.equal(output.after, "off");
});

test("level is unchanged when it already matches", async () => {
  const calls = mockCloudflare({ ...zoneLookup, [`GET /zones/${zone.id}/settings`]: SETTINGS });
  const output = await securityCommand(["level", "high", "--zone", "example.com"]);
  assert.equal(output.unchanged, true);
  assert.ok(!calls.some((c) => c.method === "PATCH"));
});

test("level rejects a bad value before any write", async () => {
  const calls = mockCloudflare({ ...zoneLookup });
  await assert.rejects(() => securityCommand(["level", "paranoid", "--zone", "example.com"]), /unknown value/);
  assert.ok(!calls.some((c) => c.method === "PATCH"));
});

test("a 403 on write names the missing permission", async () => {
  mockCloudflare({
    ...zoneLookup,
    [`GET ${BOT_URL}`]: BOT,
    [`PUT ${BOT_URL}`]: { __status: 403, payload: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } },
  });
  await assert.rejects(
    () => securityCommand(["bot-fight", "off", "--zone", "example.com"]),
    /Zone > Bot Management: Edit/,
  );
  mockCloudflare({
    ...zoneLookup,
    [`GET /zones/${zone.id}/settings`]: SETTINGS,
    [`PATCH /zones/${zone.id}/settings/security_level`]: { __status: 403, payload: { success: false, errors: [{ code: 10000, message: "x" }] } },
  });
  await assert.rejects(
    () => securityCommand(["level", "low", "--zone", "example.com"]),
    /Zone > Zone Settings: Edit/,
  );
});
