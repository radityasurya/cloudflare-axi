import test from "node:test";
import assert from "node:assert/strict";
import { AxiError } from "axi-sdk-js";
import { dnsCommand, fqdn } from "../src/commands/dns.js";
import { mockCloudflare, page, withToken, zone, zoneLookup } from "./helpers.js";

test.beforeEach(withToken);

const RECORD = {
  id: "r".repeat(32),
  name: "www.example.com",
  type: "A",
  content: "203.0.113.10",
  ttl: 1,
  proxied: true,
};

test("fqdn expands a subdomain and collapses the apex", () => {
  assert.equal(fqdn("www", "example.com"), "www.example.com");
  assert.equal(fqdn("@", "example.com"), "example.com");
  assert.equal(fqdn("example.com", "example.com"), "example.com");
  assert.equal(fqdn("WWW.example.com.", "example.com"), "www.example.com");
});

test("set is a no-op when the record already matches", async () => {
  const calls = mockCloudflare({
    ...zoneLookup,
    [`GET /zones/${zone.id}/dns_records`]: page([RECORD]),
  });
  const output = await dnsCommand(["set", "www", "A", "203.0.113.10", "--zone", "example.com"]);

  assert.equal(output.unchanged, true);
  assert.match(output.note, /no-op/);
  assert.equal(
    calls.filter((call) => call.method !== "GET").length,
    0,
    "an already-correct record must not be written",
  );
});

test("set patches only the fields that drifted", async () => {
  let patched;
  mockCloudflare({
    ...zoneLookup,
    [`GET /zones/${zone.id}/dns_records`]: page([RECORD]),
    [`PATCH /zones/${zone.id}/dns_records/${RECORD.id}`]: ({ body }) => {
      patched = body;
      return { ...RECORD, content: "203.0.113.99" };
    },
  });
  const output = await dnsCommand(["set", "www", "A", "203.0.113.99", "--zone", "example.com"]);

  assert.equal(output.updated, "content");
  assert.deepEqual(patched, { content: "203.0.113.99" }, "untouched fields must not be sent");
});

test("set creates when nothing matches", async () => {
  let created;
  mockCloudflare({
    ...zoneLookup,
    [`GET /zones/${zone.id}/dns_records`]: page([]),
    [`POST /zones/${zone.id}/dns_records`]: ({ body }) => {
      created = body;
      return { ...RECORD, name: "api.example.com", content: "203.0.113.5", proxied: false };
    },
  });
  const output = await dnsCommand(["set", "api", "A", "203.0.113.5", "--zone", "example.com"]);

  assert.equal(output.created, true);
  assert.equal(created.name, "api.example.com");
  assert.equal(created.ttl, 1, "creates default to automatic TTL");
});

test("set refuses to guess when several records share the name", async () => {
  mockCloudflare({
    ...zoneLookup,
    [`GET /zones/${zone.id}/dns_records`]: page([RECORD, { ...RECORD, id: "s".repeat(32) }]),
  });
  await assert.rejects(
    () => dnsCommand(["set", "www", "A", "203.0.113.1", "--zone", "example.com"]),
    (error) => error instanceof AxiError && error.code === "VALIDATION_ERROR",
  );
});

test("delete on an absent record is a no-op, not a failure", async () => {
  mockCloudflare({ ...zoneLookup, [`GET /zones/${zone.id}/dns_records`]: page([]) });
  const output = await dnsCommand(["delete", "gone", "--zone", "example.com"]);
  assert.match(output.deleted, /already absent/);
});

test("proxying a TXT record fails before any API call", async () => {
  const calls = mockCloudflare(zoneLookup);
  await assert.rejects(
    () => dnsCommand(["set", "txt", "TXT", "hello", "--proxied", "--zone", "example.com"]),
    (error) => error.code === "VALIDATION_ERROR" && /can not be proxied/.test(error.message),
  );
  assert.equal(calls.length, 0);
});

test("an unknown flag fails loud and names the valid flags", async () => {
  mockCloudflare(zoneLookup);
  await assert.rejects(
    () => dnsCommand(["list", "--typ", "A"]),
    (error) =>
      error.code === "VALIDATION_ERROR" &&
      /unknown flag --typ/.test(error.message) &&
      error.suggestions.some((s) => s.includes("--type")),
  );
});

test("a renamed flag points at its replacement", async () => {
  mockCloudflare(zoneLookup);
  await assert.rejects(
    () => dnsCommand(["list", "--domain", "example.com"]),
    (error) => error.suggestions.some((s) => s.includes("was renamed; use --zone")),
  );
});

test("an empty list states the zero explicitly", async () => {
  mockCloudflare({ ...zoneLookup, [`GET /zones/${zone.id}/dns_records`]: page([]) });
  const output = await dnsCommand(["list", "--zone", "example.com"]);
  assert.match(output.records, /^0 records found/);
});

test("list reports the grand total, not just the page", async () => {
  mockCloudflare({
    ...zoneLookup,
    [`GET /zones/${zone.id}/dns_records`]: page([RECORD], 42),
  });
  const output = await dnsCommand(["list", "--zone", "example.com", "--limit", "1"]);
  assert.equal(output.count, "1 of 42 total");
  assert.ok(output.help.some((line) => line.includes("--limit 42")));
});
