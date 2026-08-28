import { AxiError } from "axi-sdk-js";

const BASE = "https://api.cloudflare.com/client/v4";
const ID_RE = /^[0-9a-f]{32}$/i;

// Cloudflare caps /zones and email-routing listings at 50 per page, so any
// "give me everything" listing has to page. DNS records allow far more.
const PAGE_MAX = { default: 50, dns: 1000 };

export function resolveToken(env = process.env) {
  const token = env.CLOUDFLARE_API_TOKEN || env.CF_API_TOKEN;
  if (!token) {
    throw new AxiError(
      "No Cloudflare API token found in the environment",
      "AUTH_REQUIRED",
      [
        "Create a scoped token at https://dash.cloudflare.com/profile/api-tokens",
        "Grant Zone:Read, DNS:Edit, Cache Purge:Purge (and Email Routing:Edit for `email`)",
        "Export it as CLOUDFLARE_API_TOKEN",
      ],
    );
  }
  return token;
}

/** Translate a Cloudflare error envelope into an actionable AxiError. */
function apiError(status, errors) {
  const first = errors?.[0] ?? {};
  const message = first.message || `Cloudflare API request failed (HTTP ${status})`;
  const code = first.code;

  if (status === 401 || status === 403 || code === 10000 || code === 9109) {
    return new AxiError(message, "AUTH_ERROR", [
      "Verify CLOUDFLARE_API_TOKEN is current and not expired",
      "Check the token has permission for this resource at https://dash.cloudflare.com/profile/api-tokens",
    ]);
  }
  if (status === 429) {
    return new AxiError(message, "RATE_LIMITED", ["Wait and retry; Cloudflare is throttling this token"]);
  }
  // Surface Cloudflare's own error chain — it is usually the actionable part.
  const detail = errors?.slice(1).map((e) => e.message).filter(Boolean) ?? [];
  return new AxiError(message, "API_ERROR", detail);
}

export async function cf(path, options = {}) {
  const { method = "GET", body, query, env = process.env, fetchImpl = fetch } = options;
  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }

  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${resolveToken(env)}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new AxiError(`Could not reach the Cloudflare API: ${cause.message}`, "NETWORK_ERROR", [
      "Check network connectivity to api.cloudflare.com",
    ]);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new AxiError(
      `Cloudflare returned a non-JSON response (HTTP ${response.status})`,
      "API_ERROR",
    );
  }
  if (!response.ok || payload?.success === false) throw apiError(response.status, payload?.errors);
  return payload;
}

/**
 * Fetch up to `limit` items, following pages when the endpoint's per-page cap
 * is smaller than what was asked for. Returns the reported grand total too, so
 * callers can print `count: N of M total` without a second round trip.
 */
export async function cfList(path, options = {}) {
  const { limit = 100, query = {}, perPageMax = PAGE_MAX.default, ...rest } = options;
  const items = [];
  let total = 0;
  for (let page = 1; ; page += 1) {
    const perPage = Math.min(perPageMax, Math.max(limit - items.length, 1));
    const payload = await cf(path, { ...rest, query: { ...query, page, per_page: perPage } });
    const batch = payload.result ?? [];
    items.push(...batch);
    total = payload.result_info?.total_count ?? items.length;
    const done =
      batch.length === 0 || items.length >= limit || items.length >= total || batch.length < perPage;
    if (done) break;
  }
  return { items: items.slice(0, limit), total };
}

export const dnsPageMax = PAGE_MAX.dns;

let accountCache;
export async function resolveAccountId(options = {}) {
  if (options.accountId) return options.accountId;
  if (accountCache) return accountCache;
  const { items } = await cfList("/accounts", { ...options, limit: 50 });
  if (items.length === 0) {
    throw new AxiError("This token can not see any Cloudflare account", "AUTH_ERROR", [
      "Grant the token Account:Read, or pass --account <id>",
    ]);
  }
  if (items.length > 1 && !options.accountId) {
    throw new AxiError(
      `Token spans ${items.length} accounts; the account is ambiguous`,
      "VALIDATION_ERROR",
      [
        "Pass `--account <id>` to choose one",
        ...items.slice(0, 5).map((a) => `Run with --account ${a.id}  # ${a.name}`),
      ],
    );
  }
  accountCache = items[0].id;
  return accountCache;
}

/**
 * Resolve a zone from a flag, env var, or a single-zone account. Returns
 * `{ id, name }` — commands print the name so agents can confirm the target.
 */
export async function resolveZone(selector, options = {}) {
  const env = options.env ?? process.env;
  const wanted = selector || env.CLOUDFLARE_ZONE;

  if (wanted && ID_RE.test(wanted)) {
    const { result } = await cf(`/zones/${wanted}`, options);
    return { id: result.id, name: result.name };
  }
  if (wanted) {
    const { items } = await cfList("/zones", { ...options, query: { name: wanted }, limit: 1 });
    if (items.length === 0) {
      throw new AxiError(`No zone named ${wanted} on this account`, "NOT_FOUND", [
        "Run `cloudflare-axi zone list` to see available zones",
      ]);
    }
    return { id: items[0].id, name: items[0].name };
  }

  const { items, total } = await cfList("/zones", { ...options, limit: 50 });
  if (items.length === 1) return { id: items[0].id, name: items[0].name };
  if (items.length === 0) {
    throw new AxiError("This token can not see any zone", "AUTH_ERROR", [
      "Grant the token Zone:Read for the zones you want to manage",
    ]);
  }
  throw new AxiError(`Zone is ambiguous: this token sees ${total} zones`, "VALIDATION_ERROR", [
    "Pass `--zone <name>` to choose one, or set CLOUDFLARE_ZONE",
    ...items.slice(0, 5).map((z) => `Run with --zone ${z.name}`),
  ]);
}

export function resetCaches() {
  accountCache = undefined;
}
