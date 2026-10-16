import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnstileCommand } from "../src/commands/turnstile.js";
import { mockCloudflare, page, withToken } from "./helpers.js";

const ACCOUNT = "a".repeat(32);
const W = `/accounts/${ACCOUNT}/challenges/widgets`;
const accounts = { "GET /accounts": page([{ id: ACCOUNT, name: "acct" }]) };
const widget = { name: "contact", sitekey: "0x4AAA", mode: "managed", domains: ["example.com"], secret: "s3cret" };

test.beforeEach(withToken);

test("list shows widgets and never the secret", async () => {
  mockCloudflare({ ...accounts, [`GET ${W}`]: page([widget]) });
  const out = await turnstileCommand(["list"]);
  assert.deepEqual(out.widgets, [
    { name: "contact", sitekey: "0x4AAA", mode: "managed", domains: "example.com" },
  ]);
  assert.ok(!JSON.stringify(out).includes("s3cret"));
});

test("create without --secret-file does not print the secret", async () => {
  const calls = mockCloudflare({ ...accounts, [`GET ${W}`]: page([]), [`POST ${W}`]: widget });
  const out = await turnstileCommand(["create", "contact", "--domain", "example.com", "--domain", "b.com"]);
  assert.deepEqual(calls.find((c) => c.method === "POST").body, {
    name: "contact",
    domains: ["example.com", "b.com"],
    mode: "managed",
  });
  assert.equal(out.created, true);
  assert.ok(!JSON.stringify(out).includes("s3cret"));
  assert.match(out.note, /shown once/);
});

test("create --secret-file writes mode 600 and prints only the path", async () => {
  mockCloudflare({ ...accounts, [`GET ${W}`]: page([]), [`POST ${W}`]: widget });
  const file = join(await mkdtemp(join(tmpdir(), "ts-")), "t.env");
  const out = await turnstileCommand(["create", "contact", "--domain", "example.com", "--secret-file", file]);
  assert.equal(out.secret_file, file);
  assert.ok(!JSON.stringify(out).includes("s3cret"));
  assert.equal(await readFile(file, "utf8"), "SITEKEY=0x4AAA\nSECRET=s3cret\n");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("create is a no-op when the name exists, and validates input", async () => {
  const calls = mockCloudflare({ ...accounts, [`GET ${W}`]: page([widget]) });
  const out = await turnstileCommand(["create", "contact", "--domain", "example.com"]);
  assert.equal(out.unchanged, true);
  assert.ok(!calls.some((c) => c.method === "POST"));
  await assert.rejects(turnstileCommand(["create", "x"]), /--domain is required/);
  await assert.rejects(turnstileCommand(["create", "x", "--domain", "a.com", "--mode", "bad"]), /unknown mode/);
});

test("delete removes by sitekey and is a no-op when absent", async () => {
  const calls = mockCloudflare({
    ...accounts,
    [`GET ${W}`]: page([widget]),
    [`DELETE ${W}/0x4AAA`]: {},
  });
  assert.equal((await turnstileCommand(["delete", "0x4AAA"])).deleted, "contact");
  assert.ok(calls.some((c) => c.method === "DELETE"));
  assert.match((await turnstileCommand(["delete", "0xNOPE"])).deleted, /no-op/);
});
