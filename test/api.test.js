import test from "node:test";
import assert from "node:assert/strict";
import { AxiError } from "axi-sdk-js";
import { cacheCommand } from "../src/commands/cache.js";
import { cfList, resolveToken, resolveZone } from "../src/api.js";
import { mockCloudflare, page, withToken, zone, zoneLookup } from "./helpers.js";

test.beforeEach(withToken);

test("a missing token is an actionable error, not a crash", () => {
  assert.throws(
    () => resolveToken({}),
    (error) => error instanceof AxiError && error.code === "AUTH_REQUIRED",
  );
});

test("cfList pages past Cloudflare's 50-per-page cap", async () => {
  const zones = Array.from({ length: 120 }, (_, index) => ({
    id: String(index).padStart(32, "0"),
    name: `z${index}.com`,
  }));
  const calls = mockCloudflare({
    "GET /zones": ({ query }) => {
      const perPage = Number(query.per_page);
      const start = (Number(query.page) - 1) * perPage;
      return page(zones.slice(start, start + perPage), zones.length);
    },
  });

  const { items, total } = await cfList("/zones", { limit: 120 });
  assert.equal(items.length, 120);
  assert.equal(total, 120);
  assert.equal(calls.length, 3, "120 items at a 50 cap needs three pages");
  assert.ok(calls.every((call) => Number(call.query.per_page) <= 50));
});

test("an ambiguous zone lists the candidates instead of guessing", async () => {
  mockCloudflare({
    "GET /zones": page([
      { id: "1".repeat(32), name: "a.com" },
      { id: "2".repeat(32), name: "b.com" },
    ]),
  });
  await assert.rejects(
    () => resolveZone(undefined),
    (error) =>
      error.code === "VALIDATION_ERROR" && error.suggestions.some((s) => s.includes("--zone a.com")),
  );
});

test("a single-zone token needs no --zone", async () => {
  mockCloudflare({ "GET /zones": page([zone]) });
  assert.deepEqual(await resolveZone(undefined), { id: zone.id, name: zone.name });
});

test("a 403 becomes an auth error naming the token", async () => {
  mockCloudflare({
    "GET /zones": {
      __status: 403,
      payload: { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
    },
  });
  await assert.rejects(
    () => resolveZone("example.com"),
    (error) => error.code === "AUTH_ERROR" && error.suggestions.some((s) => /token/i.test(s)),
  );
});

test("cache purge --all sends purge_everything", async () => {
  let sent;
  mockCloudflare({
    ...zoneLookup,
    [`POST /zones/${zone.id}/purge_cache`]: ({ body }) => {
      sent = body;
      return { id: zone.id };
    },
  });
  const output = await cacheCommand(["purge", "--all", "--zone", "example.com"]);

  assert.deepEqual(sent, { purge_everything: true });
  assert.equal(output.purged, "everything");
});

test("cache purge rejects two selectors in one call", async () => {
  mockCloudflare(zoneLookup);
  await assert.rejects(
    () =>
      cacheCommand([
        "purge",
        "--url",
        "https://example.com/a",
        "--host",
        "example.com",
        "--zone",
        "example.com",
      ]),
    (error) => error.code === "VALIDATION_ERROR" && /one purge selector/.test(error.message),
  );
});

test("cache purge with no selector explains what to pass", async () => {
  mockCloudflare(zoneLookup);
  await assert.rejects(
    () => cacheCommand(["purge", "--zone", "example.com"]),
    (error) => error.suggestions.some((s) => s.includes("--url/--host/--prefix/--tag")),
  );
});
