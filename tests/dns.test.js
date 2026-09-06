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

const TXT_ZONE = { ...zoneLookup };
const SPF = {
  id: "s".repeat(32),
  name: "example.com",
  type: "TXT",
  content: "v=spf1 include:spf.brevo.com mx ~all",
  ttl: 1,
};

test("a second TXT at the same name is added, not patched over the first", async () => {
  const calls = mockCloudflare({
    ...TXT_ZONE,
    [`GET /zones/${zone.id}/dns_records`]: page([SPF]),
    [`POST /zones/${zone.id}/dns_records`]: ({ body }) => ({ ...body, id: "n".repeat(32) }),
  });
  const output = await dnsCommand(["set", "@", "TXT", "google-site-verification=abc"]);

  assert.equal(output.created, true);
  // Patching here would silently destroy the zone's SPF record.
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
  assert.equal(calls.find((c) => c.method === "POST").body.content, "google-site-verification=abc");
});

test("re-setting an identical TXT is still a no-op", async () => {
  const calls = mockCloudflare({
    ...TXT_ZONE,
    [`GET /zones/${zone.id}/dns_records`]: page([SPF]),
  });
  const output = await dnsCommand(["set", "@", "TXT", "v=spf1 include:spf.brevo.com mx ~all"]);

  assert.equal(output.unchanged, true);
  assert.equal(calls.filter((c) => c.method === "POST" || c.method === "PATCH").length, 0);
});

test("an A record with one existing value still updates in place", async () => {
  const A = { id: "a".repeat(32), name: "example.com", type: "A", content: "203.0.113.1", ttl: 1 };
  const calls = mockCloudflare({
    ...TXT_ZONE,
    [`GET /zones/${zone.id}/dns_records`]: page([A]),
    [`PATCH /zones/${zone.id}/dns_records/${A.id}`]: ({ body }) => ({ ...A, ...body }),
  });
  const output = await dnsCommand(["set", "@", "A", "203.0.113.9"]);

  // Single-valued types must keep the old behaviour: one A record, patched.
  assert.equal(output.updated, "content");
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});
