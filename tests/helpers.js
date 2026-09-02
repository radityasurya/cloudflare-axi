import { resetCaches } from "../src/api.js";

const ZONE = { id: "z".repeat(32), name: "example.com", status: "active", plan: { name: "Free" } };

/**
 * Stand in for api.cloudflare.com. `routes` maps "METHOD /path" to either a
 * result value or a function of ({ query, body }). Returns the call log so a
 * test can assert what was (and was not) sent.
 */
export function mockCloudflare(routes) {
  const calls = [];
  resetCaches();
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    // `security check` probes an arbitrary site URL through the same global
    // fetch the API client uses; route those to a separate table so a probe
    // never looks like an unrouted API call.
    if (parsed.hostname !== "api.cloudflare.com") {
      const probe = routes[`PROBE ${url}`] ?? routes["PROBE *"];
      if (!probe) throw new Error(`no probe route for ${url}`);
      return {
        ok: probe.status < 400,
        status: probe.status,
        headers: { get: (h) => probe.headers?.[h.toLowerCase()] ?? null },
        json: async () => ({}),
      };
    }
    const path = parsed.pathname.replace("/client/v4", "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, query: Object.fromEntries(parsed.searchParams) });

    const route = routes[`${method} ${path}`];
    if (route === undefined) {
      return jsonResponse(404, {
        success: false,
        errors: [{ code: 7000, message: `no route for ${method} ${path}` }],
      });
    }
    const value =
      typeof route === "function"
        ? route({ query: Object.fromEntries(parsed.searchParams), body })
        : route;
    if (value?.__status) return jsonResponse(value.__status, value.payload);
    return jsonResponse(200, {
      success: true,
      errors: [],
      result: value.result ?? value,
      ...(value.result_info ? { result_info: value.result_info } : {}),
    });
  };
  return calls;
}

function jsonResponse(status, payload) {
  return { ok: status < 400, status, json: async () => payload };
}

export function page(items, total = items.length) {
  return { result: items, result_info: { total_count: total, count: items.length } };
}

export const zone = ZONE;
export const zoneLookup = { "GET /zones": ({ query }) => page(query.name ? [ZONE] : [ZONE]) };

export function withToken() {
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  delete process.env.CLOUDFLARE_ZONE;
}
