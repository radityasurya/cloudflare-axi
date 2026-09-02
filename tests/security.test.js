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
  assert.match(output.verdict, /JS challenge/);
  assert.match(output.verdict, /bot_fight_mode/);
  assert.match(output.verdict, /browser_check/);
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
