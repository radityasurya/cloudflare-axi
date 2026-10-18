import test from "node:test";
import assert from "node:assert/strict";
import { zoneCommand } from "../src/commands/zone.js";
import { mockCloudflare, page, withToken, zone, zoneLookup } from "./helpers.js";

const NS = ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"];

test.beforeEach(withToken);

test("create adds the zone and prints the nameservers to set at the registrar", async () => {
  const calls = mockCloudflare({
    "GET /zones": page([]),
    "GET /accounts": page([{ id: "acct", name: "Test" }]),
    "POST /zones": { id: zone.id, name: "new.example", status: "pending", name_servers: NS },
  });
  const output = await zoneCommand(["create", "new.example"]);

  assert.equal(output.created, true);
  assert.equal(output.zone.status, "pending");
  assert.equal(output.nameservers, NS.join(" "));
  assert.equal(calls.find((c) => c.method === "POST").body.type, "full");
});

test("creating a zone that already exists is a no-op that still shows the nameservers", async () => {
  const calls = mockCloudflare({
    "GET /zones": page([{ ...zone, name: "example.com", name_servers: NS }]),
  });
  const output = await zoneCommand(["create", "example.com"]);

  assert.equal(output.unchanged, true);
  assert.equal(output.nameservers, NS.join(" "));
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

test("a URL instead of a domain is rejected before any request", async () => {
  const calls = mockCloudflare({});
  await assert.rejects(() => zoneCommand(["create", "https://example.com/path"]), (error) => {
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.match(error.suggestions.join(" "), /without a scheme/);
    return true;
  });
  assert.equal(calls.length, 0);
});

test("zone settings show reads one setting", async () => {
  mockCloudflare({
    ...zoneLookup,
    [`GET /zones/${zone.id}/settings/always_use_https`]: { id: "always_use_https", value: "off", editable: true },
  });
  const out = await zoneCommand(["settings", "show", "always_use_https"]);
  assert.equal(out.always_use_https, "off");
});

test("zone settings set validates, patches, and is idempotent", async () => {
  const path = `/zones/${zone.id}/settings/min_tls_version`;
  const calls = mockCloudflare({
    ...zoneLookup,
    [`GET ${path}`]: { value: "1.0" },
    [`PATCH ${path}`]: ({ body }) => ({ value: body.value }),
  });
  await assert.rejects(zoneCommand(["settings", "set", "min_tls_version", "9"]), /unknown value/);
  const out = await zoneCommand(["settings", "set", "min_tls_version", "1.2"]);
  assert.deepEqual([out.before, out.after], ["1.0", "1.2"]);
  assert.deepEqual(calls.find((c) => c.method === "PATCH").body, { value: "1.2" });

  mockCloudflare({ ...zoneLookup, [`GET ${path}`]: { value: "1.2" } });
  assert.equal((await zoneCommand(["settings", "set", "min_tls_version", "1.2"])).unchanged, true);
});

test("zone settings set passes unknown settings through", async () => {
  const path = `/zones/${zone.id}/settings/brotli`;
  const calls = mockCloudflare({
    ...zoneLookup,
    [`GET ${path}`]: { value: "off" },
    [`PATCH ${path}`]: { value: "on" },
  });
  await zoneCommand(["settings", "set", "brotli", "on"]);
  assert.equal(calls.at(-1).method, "PATCH");
});

test("zone settings set sends numeric settings as numbers", async () => {
  const path = `/zones/${zone.id}/settings/browser_cache_ttl`;
  const calls = mockCloudflare({
    ...zoneLookup,
    [`GET ${path}`]: { value: 14400 },
    [`PATCH ${path}`]: ({ body }) => ({ value: body.value }),
  });
  const out = await zoneCommand(["settings", "set", "browser_cache_ttl", "0"]);
  const patch = calls.find((c) => c.method === "PATCH");
  assert.deepEqual(patch.body, { value: 0 });
  assert.equal(typeof patch.body.value, "number");
  assert.deepEqual([out.before, out.after], [14400, 0]);
  await assert.rejects(zoneCommand(["settings", "set", "browser_cache_ttl", "abc"]), /unknown value/);
  await assert.rejects(zoneCommand(["settings", "set", "browser_cache_ttl", "1.5"]), /unknown value/);
  await assert.rejects(zoneCommand(["settings", "set", "challenge_ttl", "301"]), /unknown value/);

  mockCloudflare({ ...zoneLookup, [`GET ${path}`]: { value: 0 } });
  assert.equal((await zoneCommand(["settings", "set", "browser_cache_ttl", "0"])).unchanged, true);
});

test("zone settings set keeps string settings as strings", async () => {
  const path = `/zones/${zone.id}/settings/brotli`;
  const calls = mockCloudflare({
    ...zoneLookup,
    [`GET ${path}`]: { value: "off" },
    [`PATCH ${path}`]: ({ body }) => ({ value: body.value }),
  });
  await zoneCommand(["settings", "set", "brotli", "on"]);
  assert.deepEqual(calls.find((c) => c.method === "PATCH").body, { value: "on" });
});
