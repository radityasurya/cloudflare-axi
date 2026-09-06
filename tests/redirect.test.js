import test from "node:test";
import assert from "node:assert/strict";
import { AxiError } from "axi-sdk-js";
import { redirectCommand } from "../src/commands/redirect.js";
import { mockCloudflare, page, withToken, zone, zoneLookup } from "./helpers.js";

const ENTRY = `/zones/${zone.id}/rulesets/phases/http_request_dynamic_redirect/entrypoint`;

function rule(overrides = {}) {
  return {
    id: "r".repeat(32),
    action: "redirect",
    expression: "true",
    description: "redirect to https://new.example",
    action_parameters: {
      from_value: {
        status_code: 301,
        preserve_query_string: true,
        target_url: { expression: 'concat("https://new.example", http.request.uri.path)' },
      },
    },
    ...overrides,
  };
}

test.beforeEach(withToken);

test("list reports an empty phase instead of failing", async () => {
  mockCloudflare({ ...zoneLookup, [`GET ${ENTRY}`]: { __status: 404, payload: { success: false, errors: [{ code: 1000, message: "not found" }] } } });
  const output = await redirectCommand(["list"]);
  assert.match(output.redirects, /0 redirect rules/);
});

test("set creates the first rule and preserves path and query by default", async () => {
  const calls = mockCloudflare({
    ...zoneLookup,
    [`GET ${ENTRY}`]: { id: "e".repeat(32), rules: [] },
    [`PUT ${ENTRY}`]: ({ body }) => ({ id: "e".repeat(32), rules: body.rules.map((r, i) => ({ ...r, id: `${i}`.padStart(32, "0") })) }),
  });
  const output = await redirectCommand(["set", "https://new.example"]);

  const put = calls.find((c) => c.method === "PUT");
  const sent = put.body.rules[0].action_parameters.from_value;
  assert.equal(sent.status_code, 301);
  assert.equal(sent.preserve_query_string, true);
  assert.equal(sent.target_url.expression, 'concat("https://new.example", http.request.uri.path)');
  assert.equal(put.body.rules[0].expression, "true");
  assert.equal(output.created, true);
});

test("a trailing slash on the target does not double up in the path", async () => {
  const calls = mockCloudflare({
    ...zoneLookup,
    [`GET ${ENTRY}`]: { rules: [] },
    [`PUT ${ENTRY}`]: ({ body }) => ({ rules: body.rules }),
  });
  await redirectCommand(["set", "https://new.example/"]);
  const sent = calls.find((c) => c.method === "PUT").body.rules[0].action_parameters.from_value;
  assert.equal(sent.target_url.expression, 'concat("https://new.example", http.request.uri.path)');
});

test("--no-path sends everything to the bare target", async () => {
  const calls = mockCloudflare({
    ...zoneLookup,
    [`GET ${ENTRY}`]: { rules: [] },
    [`PUT ${ENTRY}`]: ({ body }) => ({ rules: body.rules }),
  });
  await redirectCommand(["set", "https://new.example", "--no-path", "--status", "302"]);
  const sent = calls.find((c) => c.method === "PUT").body.rules[0].action_parameters.from_value;
  assert.equal(sent.target_url.value, "https://new.example");
  assert.equal(sent.status_code, 302);
});

test("an identical rule is a no-op that never writes", async () => {
  const calls = mockCloudflare({ ...zoneLookup, [`GET ${ENTRY}`]: { rules: [rule()] } });
  const output = await redirectCommand(["set", "https://new.example"]);

  assert.equal(output.unchanged, true);
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0, "a no-op must not rewrite the ruleset");
});

test("retargeting the same expression replaces that rule instead of stacking one behind it", async () => {
  const calls = mockCloudflare({
    ...zoneLookup,
    [`GET ${ENTRY}`]: { rules: [rule()] },
    [`PUT ${ENTRY}`]: ({ body }) => ({ rules: body.rules }),
  });
  await redirectCommand(["set", "https://newer.example"]);

  const sent = calls.find((c) => c.method === "PUT").body.rules;
  assert.equal(sent.length, 1, "a second rule on the same expression would be unreachable");
  assert.match(sent[0].action_parameters.from_value.target_url.expression, /newer\.example/);
});

test("writing one rule sends the others back untouched", async () => {
  const other = rule({ id: "a".repeat(32), expression: 'http.host eq "keep.example"', description: "keep me" });
  const calls = mockCloudflare({
    ...zoneLookup,
    [`GET ${ENTRY}`]: { rules: [other] },
    [`PUT ${ENTRY}`]: ({ body }) => ({ rules: body.rules }),
  });
  await redirectCommand(["set", "https://new.example"]);

  const sent = calls.find((c) => c.method === "PUT").body.rules;
  // A PUT replaces the whole ruleset, so an omitted rule is a silent deletion.
  assert.equal(sent.length, 2);
  assert.ok(sent.some((r) => r.description === "keep me"));
});

test("delete drops only the named rule", async () => {
  const keep = rule({ id: "a".repeat(32), expression: 'http.host eq "keep.example"', description: "keep me" });
  const calls = mockCloudflare({
    ...zoneLookup,
    [`GET ${ENTRY}`]: { rules: [rule(), keep] },
    [`PUT ${ENTRY}`]: ({ body }) => ({ rules: body.rules }),
  });
  await redirectCommand(["delete", "redirect to https://new.example"]);

  const sent = calls.find((c) => c.method === "PUT").body.rules;
  assert.deepEqual(sent.map((r) => r.description), ["keep me"]);
});

test("deleting an absent rule is a no-op, not an error", async () => {
  const calls = mockCloudflare({ ...zoneLookup, [`GET ${ENTRY}`]: { rules: [] } });
  const output = await redirectCommand(["delete", "nothing-here"]);
  assert.match(output.deleted, /no redirect rule/);
  assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
});

test("a target with no scheme is rejected before the zone is touched", async () => {
  const calls = mockCloudflare({});
  await assert.rejects(() => redirectCommand(["set", "new.example"]), (error) => {
    assert.ok(error instanceof AxiError);
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.match(error.suggestions.join(" "), /https:\/\/new\.example/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("an unsupported status is rejected before the zone is touched", async () => {
  const calls = mockCloudflare({});
  await assert.rejects(() => redirectCommand(["set", "https://new.example", "--status", "418"]), (error) => {
    assert.match(error.suggestions.join(" "), /301/);
    return true;
  });
  assert.equal(calls.length, 0);
});
