import test from "node:test";
import assert from "node:assert/strict";
import { zoneCommand } from "../src/commands/zone.js";
import { mockCloudflare, page, withToken, zone } from "./helpers.js";

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
