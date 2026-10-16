import test from "node:test";
import assert from "node:assert/strict";
import { address, emailCommand } from "../src/commands/email.js";
import { mockCloudflare, page, withToken, zone, zoneLookup } from "./helpers.js";

test.beforeEach(withToken);

const RULE = {
  id: "e".repeat(32),
  tag: "e".repeat(32),
  enabled: true,
  matchers: [{ type: "literal", field: "to", value: "hi@example.com" }],
  actions: [{ type: "forward", value: ["me@gmail.com"] }],
};

const ACCOUNT = { id: "a".repeat(32), name: "Personal" };

test("address qualifies a bare local part against the zone", () => {
  assert.equal(address("hi", "example.com"), "hi@example.com");
  assert.equal(address("Me@Gmail.com", "example.com"), "me@gmail.com");
});

test("route is a no-op when the rule already forwards there", async () => {
  const calls = mockCloudflare({
    ...zoneLookup,
    "GET /accounts": page([ACCOUNT]),
    [`GET /zones/${zone.id}/email/routing/rules`]: page([RULE]),
    [`GET /accounts/${ACCOUNT.id}/email/routing/addresses`]: page([
      { email: "me@gmail.com", verified: "2026-01-01" },
    ]),
  });
  const output = await emailCommand(["route", "hi", "me@gmail.com", "--zone", "example.com"]);

  assert.equal(output.unchanged, true);
  assert.equal(calls.filter((call) => call.method !== "GET").length, 0);
});

test("route creates a forward rule with the literal matcher Cloudflare expects", async () => {
  let created;
  mockCloudflare({
    ...zoneLookup,
    "GET /accounts": page([ACCOUNT]),
    [`GET /zones/${zone.id}/email/routing/rules`]: page([]),
    [`POST /zones/${zone.id}/email/routing/rules`]: ({ body }) => {
      created = body;
      return RULE;
    },
    [`GET /accounts/${ACCOUNT.id}/email/routing/addresses`]: page([
      { email: "me@gmail.com", verified: "2026-01-01" },
    ]),
  });
  const output = await emailCommand(["route", "hi", "me@gmail.com", "--zone", "example.com"]);

  assert.equal(output.created, true);
  assert.deepEqual(created.matchers, [{ type: "literal", field: "to", value: "hi@example.com" }]);
  assert.deepEqual(created.actions, [{ type: "forward", value: ["me@gmail.com"] }]);
});

test("route warns when the destination is unverified", async () => {
  mockCloudflare({
    ...zoneLookup,
    "GET /accounts": page([ACCOUNT]),
    [`GET /zones/${zone.id}/email/routing/rules`]: page([]),
    [`POST /zones/${zone.id}/email/routing/rules`]: RULE,
    [`GET /accounts/${ACCOUNT.id}/email/routing/addresses`]: page([
      { email: "me@gmail.com", verified: null },
    ]),
  });
  const output = await emailCommand(["route", "hi", "me@gmail.com", "--zone", "example.com"]);
  assert.match(output.warning, /not verified/);
});

test("catch-all --drop sends the all-matcher form", async () => {
  let sent;
  mockCloudflare({
    ...zoneLookup,
    [`PUT /zones/${zone.id}/email/routing/rules/catch_all`]: ({ body }) => {
      sent = body;
      return { enabled: true };
    },
  });
  const output = await emailCommand(["catch-all", "--drop", "--zone", "example.com"]);

  assert.equal(output["catch-all"], "drop");
  assert.deepEqual(sent.matchers, [{ type: "all" }]);
  assert.deepEqual(sent.actions, [{ type: "drop" }]);
});

test("catch-all rejects a destination combined with --drop", async () => {
  mockCloudflare(zoneLookup);
  await assert.rejects(
    () => emailCommand(["catch-all", "me@gmail.com", "--drop", "--zone", "example.com"]),
    (error) => error.code === "VALIDATION_ERROR",
  );
});

test("delete on an absent rule is a no-op", async () => {
  mockCloudflare({
    ...zoneLookup,
    [`GET /zones/${zone.id}/email/routing/rules`]: page([]),
  });
  const output = await emailCommand(["delete", "nope", "--zone", "example.com"]);
  assert.match(output.deleted, /already absent/);
});

test("list surfaces routing status and catch-all without failing when they are unavailable", async () => {
  mockCloudflare({
    ...zoneLookup,
    [`GET /zones/${zone.id}/email/routing/rules`]: page([RULE]),
  });
  const output = await emailCommand(["list", "--zone", "example.com"]);

  assert.equal(output.routing, "unavailable");
  assert.equal(output["catch-all"], "not configured");
  assert.equal(output.rules[0].from, "hi@example.com");
});

test("addresses add creates a destination and reports verified state", async () => {
  const A = "a".repeat(32);
  const path = `/accounts/${A}/email/routing/addresses`;
  const calls = mockCloudflare({
    "GET /accounts": page([{ id: A, name: "acct" }]),
    [`GET ${path}`]: page([]),
    [`POST ${path}`]: { email: "me@gmail.com", verified: null },
  });
  const out = await emailCommand(["addresses", "add", "Me@Gmail.com"]);
  assert.deepEqual(calls.find((c) => c.method === "POST").body, { email: "me@gmail.com" });
  assert.deepEqual(out.address, { email: "me@gmail.com", verified: false });
  assert.equal(out.created, true);
  await assert.rejects(emailCommand(["addresses", "add", "nope"]), /not an email/);
});

test("addresses add is a no-op for an existing address", async () => {
  const A = "a".repeat(32);
  const path = `/accounts/${A}/email/routing/addresses`;
  const calls = mockCloudflare({
    "GET /accounts": page([{ id: A, name: "acct" }]),
    [`GET ${path}`]: page([{ email: "me@gmail.com", verified: "2026-01-01" }]),
  });
  const out = await emailCommand(["addresses", "add", "me@gmail.com"]);
  assert.equal(out.unchanged, true);
  assert.equal(out.address.verified, true);
  assert.ok(!calls.some((c) => c.method === "POST"));
});

test("enable turns on Email Routing for the zone", async () => {
  const calls = mockCloudflare({
    ...zoneLookup,
    [`POST /zones/${zone.id}/email/routing/enable`]: { enabled: true },
  });
  const out = await emailCommand(["enable"]);
  assert.equal(out.routing, "enabled");
  assert.equal(calls.at(-1).method, "POST");
});
