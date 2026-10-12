import test from "node:test";
import assert from "node:assert/strict";
import { r2Command } from "../src/commands/r2.js";
import { mockCloudflare, page, withToken, zone } from "./helpers.js";

const ACCOUNT = "a".repeat(32);
const B = `/accounts/${ACCOUNT}/r2/buckets`;
const bucket = { name: "jala-assets", location: "WEUR", creation_date: "2026-01-01T00:00:00Z" };
const attached = {
  domain: "assets.example.com",
  zoneId: zone.id,
  zoneName: "example.com",
  enabled: true,
  minTLS: "1.2",
  status: { ownership: "active", ssl: "active" },
};
const accounts = { "GET /accounts": page([{ id: ACCOUNT, name: "acct" }]) };
const zones = {
  "GET /zones": ({ query }) => page(query.name === "example.com" ? [zone] : []),
};

test.beforeEach(withToken);

test("list returns bucket rows from the { buckets } envelope", async () => {
  mockCloudflare({ ...accounts, [`GET ${B}`]: { buckets: [bucket] } });
  const out = await r2Command([]);
  assert.deepEqual(out.buckets, [
    { name: "jala-assets", location: "WEUR", created: "2026-01-01T00:00:00Z" },
  ]);
});

test("get shows the bucket and its custom domains", async () => {
  mockCloudflare({
    ...accounts,
    [`GET ${B}/jala-assets`]: bucket,
    [`GET ${B}/jala-assets/domains/custom`]: { domains: [attached] },
  });
  const out = await r2Command(["get", "jala-assets"]);
  assert.equal(out.bucket.name, "jala-assets");
  assert.equal(out.domains[0].domain, "assets.example.com");
  assert.equal(out.domains[0].min_tls, "1.2");
});

test("domain list prints status, enabled and min TLS", async () => {
  mockCloudflare({ ...accounts, [`GET ${B}/jala-assets/domains/custom`]: { domains: [attached] } });
  const out = await r2Command(["domain", "list", "jala-assets"]);
  assert.deepEqual(out.domains[0], {
    domain: "assets.example.com",
    zone: "example.com",
    status: "ownership active, ssl active",
    enabled: true,
    min_tls: "1.2",
  });
});

test("domain add resolves the registrable zone and posts zoneId", async () => {
  const calls = mockCloudflare({
    ...accounts,
    ...zones,
    [`GET ${B}/jala-assets/domains/custom`]: { domains: [] },
    [`POST ${B}/jala-assets/domains/custom`]: ({ body }) => ({ ...body }),
  });
  const out = await r2Command(["domain", "add", "jala-assets", "Assets.Example.com", "--min-tls", "1.2"]);
  const post = calls.find((c) => c.method === "POST");
  assert.deepEqual(post.body, {
    domain: "assets.example.com",
    zoneId: zone.id,
    enabled: true,
    minTLS: "1.2",
  });
  assert.equal(out.created, true);
  assert.equal(out.domain.zone, "example.com");
  // tried the full name first, then the parent
  assert.deepEqual(
    calls.filter((c) => c.path === "/zones").map((c) => c.query.name),
    ["assets.example.com", "example.com"],
  );
});

test("domain add honors --zone", async () => {
  const calls = mockCloudflare({
    ...accounts,
    ...zones,
    [`GET ${B}/jala-assets/domains/custom`]: { domains: [] },
    [`POST ${B}/jala-assets/domains/custom`]: ({ body }) => ({ ...body }),
  });
  await r2Command(["domain", "add", "jala-assets", "cdn.other.org", "--zone", "example.com"]);
  assert.equal(calls.find((c) => c.method === "POST").body.zoneId, zone.id);
});

test("domain add on an attached domain is a no-op", async () => {
  const calls = mockCloudflare({
    ...accounts,
    [`GET ${B}/jala-assets/domains/custom`]: { domains: [attached] },
  });
  const out = await r2Command(["domain", "add", "jala-assets", "assets.example.com"]);
  assert.equal(out.unchanged, true);
  assert.equal(out.domain.domain, "assets.example.com");
  assert.ok(!calls.some((c) => c.method === "POST"));
});

test("domain add rejects a bad --min-tls before any call", async () => {
  const calls = mockCloudflare({});
  await assert.rejects(
    r2Command(["domain", "add", "jala-assets", "a.example.com", "--min-tls", "9"]),
    { code: "VALIDATION_ERROR" },
  );
  assert.equal(calls.length, 0);
});

test("domain remove deletes a present domain", async () => {
  const calls = mockCloudflare({
    ...accounts,
    [`GET ${B}/jala-assets/domains/custom`]: { domains: [attached] },
    [`DELETE ${B}/jala-assets/domains/custom/assets.example.com`]: { domain: "assets.example.com" },
  });
  const out = await r2Command(["domain", "remove", "jala-assets", "assets.example.com"]);
  assert.equal(out.removed.domain, "assets.example.com");
  assert.ok(calls.some((c) => c.method === "DELETE"));
});

test("domain remove on an absent domain is a no-op", async () => {
  const calls = mockCloudflare({
    ...accounts,
    [`GET ${B}/jala-assets/domains/custom`]: { domains: [] },
  });
  const out = await r2Command(["domain", "remove", "jala-assets", "assets.example.com"]);
  assert.match(out.removed, /no-op/);
  assert.ok(!calls.some((c) => c.method === "DELETE"));
});

test("a token without R2 permission names the missing permission", async () => {
  const denied = { __status: 403, payload: { success: false, errors: [{ code: 10000, message: "Authentication error" }] } };
  mockCloudflare({ ...accounts, [`GET ${B}`]: denied });
  await assert.rejects(r2Command(["list"]), (e) => {
    assert.equal(e.code, "AUTH_ERROR");
    assert.match(e.suggestions.join(" "), /Workers R2 Storage: Read/);
    return true;
  });

  mockCloudflare({
    ...accounts,
    ...zones,
    [`GET ${B}/jala-assets/domains/custom`]: { domains: [] },
    [`POST ${B}/jala-assets/domains/custom`]: denied,
  });
  await assert.rejects(r2Command(["domain", "add", "jala-assets", "a.example.com"]), (e) => {
    assert.match(e.suggestions.join(" "), /Workers R2 Storage: Edit/);
    return true;
  });
});
