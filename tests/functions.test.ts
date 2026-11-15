// Unit tests. The SQL-level tests live in test/sql and run through DuckDB against the
// replay server in test/mock_api (every transport).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CATALOG, TABLES } from "../src/catalog.ts";
import {
  buildUrl,
  configFromSecrets,
  type FivetranConfig,
  fivetranGet,
  normalizeBaseUrl,
  retryAfterMs,
} from "../src/fivetran/client.ts";
import type { Constraint } from "../src/fivetran/pushdown.ts";
import { HISTORY_DAYS, maskConfig, syncWindow, unifiedStatus } from "../src/fivetran/resources.ts";
import { asTime, defaultRows } from "../src/fivetran/table.ts";

const DAY = 86_400_000;

test("base_url: https required except for loopback fixtures; /v1 and trailing slash dropped", () => {
  expect(normalizeBaseUrl("https://api.fivetran.com/")).toBe("https://api.fivetran.com");
  expect(normalizeBaseUrl("https://api.fivetran.com/v1")).toBe("https://api.fivetran.com");
  expect(normalizeBaseUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080");
  expect(() => normalizeBaseUrl("http://api.fivetran.com")).toThrow(/https/);
  expect(() => normalizeBaseUrl("not a url")).toThrow(/not a URL/);
});

test("configFromSecrets: key + secret → Basic auth; page_size bounded", () => {
  expect(() => configFromSecrets({})).toThrow(/no fivetran secret/);
  expect(() => configFromSecrets({ s: { type: "fivetran", api_key: "k" } })).toThrow(/API_SECRET/);
  const cfg = configFromSecrets({ s: { type: "fivetran", api_key: "k", api_secret: "s" } });
  expect(cfg.baseUrl).toBe("https://api.fivetran.com");
  expect(cfg.authorization).toBe(`Basic ${Buffer.from("k:s").toString("base64")}`);
  expect(cfg.pageSize).toBe(1000);
  expect(configFromSecrets({ s: { type: "fivetran", api_key: "k", api_secret: "s", page_size: 5n } }).pageSize).toBe(5);
  expect(() => configFromSecrets({ s: { type: "fivetran", api_key: "k", api_secret: "s", page_size: 5000 } })).toThrow(
    /page_size/,
  );
});

test("buildUrl: drops empty parameters and encodes values", () => {
  const cfg: FivetranConfig = { baseUrl: "https://api.fivetran.com", authorization: "x", pageSize: 10 };
  expect(buildUrl(cfg, "/v1/connections", { group_id: "g 1", schema: undefined, cursor: "" })).toBe(
    "https://api.fivetran.com/v1/connections?group_id=g+1",
  );
});

test("retryAfterMs: seconds or an HTTP date", () => {
  expect(retryAfterMs(new Headers({ "Retry-After": "3" }))).toBe(3000);
  const now = Date.parse("2026-01-01T00:00:00Z");
  expect(retryAfterMs(new Headers({ "Retry-After": "Thu, 01 Jan 2026 00:00:02 GMT" }), now)).toBe(2000);
  expect(retryAfterMs(new Headers())).toBeUndefined();
});

test("asTime: Fivetran microsecond ISO timestamps keep their microseconds", () => {
  expect(asTime("2026-01-01T00:00:00.000000Z")).toBe(1_767_225_600_000_000n);
  expect(asTime("2026-01-01T00:00:00.123456Z")).toBe(1_767_225_600_123_456n);
  expect(asTime("2026-01-01T00:00:00.5Z")).toBe(1_767_225_600_500_000n);
  expect(asTime("2026-01-01T00:00:00Z")).toBe(1_767_225_600_000_000n);
  expect(asTime(null)).toBeNull();
  expect(asTime("garbage")).toBeNull();
});

test("defaultRows: list envelopes and single objects", () => {
  expect(defaultRows({ items: [{ id: 1 }], next_cursor: "x" })).toEqual([{ id: 1 }]);
  expect(defaultRows({ id: "acc" })).toEqual([{ id: "acc" }]);
  expect(defaultRows(null)).toEqual([]);
});

test("maskConfig: masks secret-looking keys at any depth, keeps the rest", () => {
  expect(
    maskConfig({
      host: "db",
      password: "p",
      port: 5432,
      nested: { client_secret: "s", list: [{ api_key: "k" }] },
      oauth_token: "",
      private_key: "-----BEGIN",
    }),
  ).toEqual({
    host: "db",
    password: "******",
    port: 5432,
    nested: { client_secret: "******", list: [{ api_key: "******" }] },
    oauth_token: "",
    private_key: "******",
  });
});

test("syncWindow: clamps pushed started_at bounds to the API's 7-day window", () => {
  const anchor = Date.parse("2026-11-15T12:00:00Z");
  const us = (ms: number) => BigInt(ms) * 1000n;
  // No bounds: the full window, ≤ 7 days, never starting more than 7 days ago.
  const full = syncWindow([], anchor);
  expect(full).not.toBeNull();
  const span = Date.parse(full?.end ?? "") - Date.parse(full?.start ?? "");
  expect(span).toBeLessThanOrEqual(HISTORY_DAYS * DAY);
  expect(Date.parse(full?.start ?? "")).toBeGreaterThan(anchor - HISTORY_DAYS * DAY);
  // A pushed range inside the window is used as is (inclusive upper bound widened by 1 ms).
  const cs: Constraint[] = [
    { kind: "cmp", column: "started_at", op: "ge", value: us(anchor - 2 * DAY) },
    { kind: "cmp", column: "started_at", op: "le", value: us(anchor - DAY) },
  ];
  expect(syncWindow(cs, anchor)).toEqual({
    start: new Date(anchor - 2 * DAY).toISOString(),
    end: new Date(anchor - DAY + 1).toISOString(),
  });
  // Older than the window: clamped to it.
  const old: Constraint[] = [{ kind: "cmp", column: "started_at", op: "gt", value: us(anchor - 30 * DAY) }];
  expect(Date.parse(syncWindow(old, anchor)?.start ?? "")).toBeGreaterThan(anchor - HISTORY_DAYS * DAY);
  // Entirely before the window: no request at all.
  const empty: Constraint[] = [{ kind: "cmp", column: "started_at", op: "lt", value: us(anchor - 10 * DAY) }];
  expect(syncWindow(empty, anchor)).toBeNull();
  // Other columns are ignored.
  expect(syncWindow([{ kind: "cmp", column: "ended_at", op: "lt", value: us(anchor - 10 * DAY) }], anchor)).toEqual(
    full,
  );
});

test("unifiedStatus: Fivetran sync statuses onto the shared status set", () => {
  const s = "2026-11-15T00:00:00Z";
  expect(unifiedStatus("COMPLETED", s, s)).toBe("success");
  expect(unifiedStatus("FAILURE", s, s)).toBe("failed");
  expect(unifiedStatus("INCOMPLETE", s, s)).toBe("failed");
  expect(unifiedStatus("CANCELED", s, s)).toBe("cancelled");
  expect(unifiedStatus("PAUSED", s, s)).toBe("cancelled");
  expect(unifiedStatus("RESCHEDULED", s, s)).toBe("skipped");
  expect(unifiedStatus("INCOMPLETE", s, null)).toBe("running");
  expect(unifiedStatus(null, null, null)).toBe("queued");
  expect(unifiedStatus("SOMETHING_NEW", s, s)).toBe("failed");
});

test("catalog: every table is documented, has examples and declares its columns", () => {
  expect(CATALOG.name).toBe("fivetran");
  expect(CATALOG.schemas.map((s) => (s.path ?? []).join("."))).toEqual(["main", "unified"]);
  for (const t of TABLES) {
    expect(t.comment).toBeTruthy();
    expect(JSON.parse(t.tags?.["vgi.example_queries"] ?? "[]").length).toBeGreaterThan(0);
    expect(t.tags?.["vgi.doc_md"]).toContain("**Pushdown:**");
    expect(t.columns?.fields.length).toBeGreaterThan(0);
  }
  // No column anywhere exposes key material.
  const names = TABLES.flatMap((t) => (t.columns?.fields ?? []).map((f) => `${t.name}.${f.name}`));
  expect(names.filter((n) => /\.(secret|key|api_secret)$/.test(n))).toEqual([]);
});

describe("fivetranGet against a local server", () => {
  let server: ReturnType<typeof Bun.serve>;
  let hits: { path: string; auth: string | null; accept: string | null }[] = [];
  let mode = "ok";

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        hits.push({
          path: url.pathname + url.search,
          auth: req.headers.get("Authorization"),
          accept: req.headers.get("Accept"),
        });
        if (mode === "429-once" && hits.length === 1) {
          return Response.json(
            { code: "TooManyRequests", message: "slow down" },
            {
              status: 429,
              headers: { "Retry-After": "1" },
            },
          );
        }
        if (mode === "404")
          return Response.json({ code: "NotFound_Connection", message: "no such connection" }, { status: 404 });
        const cursor = url.searchParams.get("cursor");
        return Response.json({
          code: "Success",
          data: { items: [{ id: cursor ?? "first" }], ...(cursor ? {} : { next_cursor: "c2" }) },
        });
      },
    });
  });
  afterAll(() => server.stop(true));

  const cfg = (): FivetranConfig => ({
    baseUrl: `http://127.0.0.1:${server.port}`,
    authorization: "Basic abc",
    pageSize: 10,
  });

  test("Basic auth, versioned Accept and next_cursor", async () => {
    hits = [];
    mode = "ok";
    const page = await fivetranGet(cfg(), "/v1/connections", { group_id: "g", limit: "10" });
    expect(hits[0]).toEqual({
      path: "/v1/connections?group_id=g&limit=10",
      auth: "Basic abc",
      accept: "application/json;version=2",
    });
    expect(page.nextCursor).toBe("c2");
    const second = await fivetranGet(cfg(), "/v1/connections", { cursor: "c2" });
    expect(second.data).toEqual({ items: [{ id: "c2" }] });
    expect(second.nextCursor).toBeNull();
  });

  test("429 honours Retry-After, then succeeds", async () => {
    hits = [];
    mode = "429-once";
    const t0 = Date.now();
    const page = await fivetranGet(cfg(), "/v1/users");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950);
    expect(hits.length).toBe(2);
    expect(page.nextCursor).toBe("c2");
  });

  test("4xx is not retried and carries Fivetran's error code and status", async () => {
    hits = [];
    mode = "404";
    await expect(fivetranGet(cfg(), "/v1/connections/x")).rejects.toThrow(/HTTP 404: NotFound_Connection/);
    expect(hits.length).toBe(1);
  });
});
