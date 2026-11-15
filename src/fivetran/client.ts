/**
 * Fivetran REST API v1 client: authentication, rate limits and cursor paging.
 *
 * - **Auth.** A `fivetran` DuckDB secret carries an API key + secret (a user's key or a
 *   system key, both are HTTP Basic `key:secret`) and an optional `base_url` (default
 *   https://api.fivetran.com). Credentials never enter table-function state.
 * - **Envelope.** Every response is `{code, message, data}`; list endpoints return
 *   `data.items` plus `data.next_cursor`, which callers keep in their scan state and pass
 *   back as `cursor`, so a scan resumes on any process.
 * - **Rate limits.** HTTP 429 waits for `Retry-After` (bounded), 5xx and network errors
 *   retry with exponential backoff; every request has a timeout.
 */

import { secretOfType } from "@query-farm/vgi";
import { log } from "../log.ts";
import { VERSION } from "../meta.ts";

export const SECRET_TYPE = "fivetran";
export const DEFAULT_BASE_URL = "https://api.fivetran.com";
export const TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 5;
/** Longest single wait for a Retry-After. */
export const MAX_RATE_WAIT_MS = 60_000;
/** Fivetran's page-size ceiling (`limit` accepts 1..1000). */
export const MAX_PAGE_SIZE = 1000;
const USER_AGENT = `vgi-fivetran-worker/${VERSION}`;

export class FivetranError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface FivetranConfig {
  baseUrl: string;
  /** Precomputed `Basic …` header value. */
  authorization: string;
  pageSize: number;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Normalize and check a base URL: https, or http only for a loopback fixture server. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new FivetranError(`fivetran secret: base_url '${raw}' is not a URL (expected e.g. ${DEFAULT_BASE_URL})`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new FivetranError(
      "fivetran secret: base_url must use https:// (http:// is accepted only for 127.0.0.1/localhost)",
    );
  }
  // Accept both https://api.fivetran.com and https://api.fivetran.com/v1.
  return url.origin + url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Build the client config from the `fivetran` secret DuckDB resolved for this call. */
export function configFromSecrets(secrets: Record<string, Record<string, unknown>>): FivetranConfig {
  const s = secretOfType(secrets as never, SECRET_TYPE) as Record<string, unknown> | undefined;
  if (!s) {
    throw new FivetranError(
      "no fivetran secret: run CREATE SECRET (TYPE fivetran, API_KEY '<key>', API_SECRET '<secret>') " +
        "with a Fivetran API key or system key",
    );
  }
  const key = str(s.api_key);
  const secret = str(s.api_secret);
  if (!key || !secret) throw new FivetranError("fivetran secret: both API_KEY and API_SECRET are required");
  let pageSize = MAX_PAGE_SIZE;
  if (s.page_size != null && s.page_size !== "") {
    const n = Number(s.page_size);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) {
      throw new FivetranError(`fivetran secret: page_size must be an integer in 1..${MAX_PAGE_SIZE}`);
    }
    pageSize = n;
  }
  return {
    baseUrl: normalizeBaseUrl(str(s.base_url) ?? DEFAULT_BASE_URL),
    authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`,
    pageSize,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long a 429 asks us to wait: `Retry-After` seconds or HTTP-date, else undefined. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const v = headers.get("Retry-After");
  if (!v) return undefined;
  if (/^\d+$/.test(v.trim())) return Number(v.trim()) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.max(0, t - now);
}

export interface FivetranResponse {
  /** The `data` member of the envelope. */
  data: unknown;
  /** `data.next_cursor` of a list response (null at the end or for single objects). */
  nextCursor: string | null;
}

/** Build the request URL for an API path (`/v1/...`) and query. */
export function buildUrl(cfg: FivetranConfig, path: string, query?: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") qs.set(k, v);
  const q = qs.toString();
  return `${cfg.baseUrl}${path}${q ? `?${q}` : ""}`;
}

/** GET one Fivetran resource (or one page of a list). */
export async function fivetranGet(
  cfg: FivetranConfig,
  path: string,
  query?: Record<string, string | undefined>,
): Promise<FivetranResponse> {
  const url = buildUrl(cfg, path, query);
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          // version=2 selects the current connection response format; other endpoints ignore it.
          Accept: "application/json;version=2",
          Authorization: cfg.authorization,
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw new FivetranError(`GET ${redact(url)} failed: ${(err as Error).message}`);
      await sleep(250 * 2 ** attempt);
      continue;
    }
    if (res.ok) {
      const text = await res.text();
      const body = (text ? JSON.parse(text) : {}) as { data?: unknown };
      const data = body.data ?? null;
      const next =
        data && typeof data === "object" && "next_cursor" in data
          ? ((data as { next_cursor?: unknown }).next_cursor as string | null | undefined)
          : null;
      return { data, nextCursor: typeof next === "string" && next !== "" ? next : null };
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new FivetranError(
        `GET ${redact(url)} failed with HTTP ${res.status}: ${await errorSummary(res)}`,
        res.status,
      );
    }
    const delay =
      res.status === 429 ? Math.min(retryAfterMs(res.headers) ?? 1000 * attempt, MAX_RATE_WAIT_MS) : 250 * 2 ** attempt;
    await res.body?.cancel();
    log.debug(`fivetran: HTTP ${res.status} for ${redact(url)}; retry ${attempt} in ${delay} ms`);
    await sleep(delay);
  }
}

/** Fivetran errors are `{code, message}`; keep it short. */
async function errorSummary(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { code?: string; message?: string };
    return [j.code, j.message].filter(Boolean).join(" - ") || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/** Show the path + query of a URL in errors (credentials are never in a URL). */
function redact(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}
