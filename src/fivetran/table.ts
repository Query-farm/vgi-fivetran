/**
 * One factory for every Fivetran collection.
 *
 * A spec names the columns (with a JSON extractor each), how pushed filters become the
 * first request of each phase, and optional fan-out over a parent collection. The
 * factory turns that into a catalog table whose scan function:
 *
 * - streams one Fivetran page per Arrow batch;
 * - keeps its cursor (`phase` + Fivetran's `next_cursor`, and for fan-outs the pending
 *   parent ids) in serializable state, so a scan resumes on any process over HTTP and
 *   survives rate-limit pauses;
 * - reads the `fivetran` secret on every call and never stores it in state;
 * - pushes filters down (narrowing only) and lets the SDK re-apply them exactly.
 */

import {
  batchFromColumns,
  bool,
  constraintRecord,
  defineTableFunction,
  field,
  float64,
  formatPushedFilters,
  int32,
  int64,
  list,
  schema,
  struct,
  type TableDescriptor,
  timestampMicros,
  utf8,
  type VgiDataType,
} from "@query-farm/vgi";
import { log } from "../log.ts";
import { type Category, column, objectTags } from "../meta.ts";
import { configFromSecrets, FivetranError, fivetranGet, SECRET_TYPE } from "./client.ts";
import { type Constraint, constraintsOf, eqValues } from "./pushdown.ts";

// ------------------------------------------------------------------ column helpers

export interface Col {
  name: string;
  type: VgiDataType;
  /** DuckDB spelling for vgi.result_columns_schema. */
  sqlType: string;
  doc: string;
  nullable: boolean;
  get: (row: Row) => unknown;
}

// biome-ignore lint/suspicious/noExplicitAny: Fivetran JSON is untyped.
export type Row = Record<string, any> & { __ctx?: Record<string, string> };

/** Walk a dotted path through untyped JSON. */
export function at(row: unknown, path: string): unknown {
  let cur: unknown = row;
  for (const p of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export const asStr = (v: unknown): string | null =>
  v == null ? null : typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
export const asBool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
export const asInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
export const asBigInt = (v: unknown): bigint | null =>
  typeof v === "number" && Number.isFinite(v) ? BigInt(Math.trunc(v)) : null;
export const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** ISO 8601 → TIMESTAMPTZ microseconds (Fivetran sends microsecond precision). */
export function asTime(v: unknown): bigint | null {
  if (typeof v !== "string" || v === "") return null;
  const m = v.match(/^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : BigInt(ms) * 1000n;
  }
  const ms = Date.parse(`${m[1]}${m[3] ?? "Z"}`);
  if (Number.isNaN(ms)) return null;
  const frac = (m[2] ?? "").padEnd(6, "0").slice(0, 6);
  return BigInt(ms) * 1000n + BigInt(frac);
}
export const asStrList = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x) => x != null).map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : null;
export const asJson = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

const JSON_META: [string, string] = ["ARROW:extension:name", "arrow.json"];

type Getter = string | ((r: Row) => unknown);
const read = (r: Row, g: Getter) => (typeof g === "string" ? at(r, g) : g(r));

function mk(name: string, type: VgiDataType, sqlType: string, doc: string, get: (r: Row) => unknown, nullable = true) {
  return { name, type, sqlType, doc, get, nullable } satisfies Col;
}

export const C = {
  str: (name: string, doc: string, g: Getter, nullable = true) =>
    mk(name, utf8(), "VARCHAR", doc, (r) => asStr(read(r, g)), nullable),
  time: (name: string, doc: string, g: Getter) =>
    mk(name, timestampMicros("UTC"), "TIMESTAMP WITH TIME ZONE", doc, (r) => asTime(read(r, g))),
  bool: (name: string, doc: string, g: Getter, nullable = true) =>
    mk(name, bool, "BOOLEAN", doc, (r) => asBool(read(r, g)), nullable),
  int: (name: string, doc: string, g: Getter) => mk(name, int32, "INTEGER", doc, (r) => asInt(read(r, g))),
  bigint: (name: string, doc: string, g: Getter) => mk(name, int64(), "BIGINT", doc, (r) => asBigInt(read(r, g))),
  num: (name: string, doc: string, g: Getter) => mk(name, float64(), "DOUBLE", doc, (r) => asNum(read(r, g))),
  strList: (name: string, doc: string, g: Getter) =>
    mk(name, list(utf8()), "VARCHAR[]", doc, (r) => asStrList(read(r, g))),
  json: (name: string, doc: string, g: Getter) => mk(name, utf8(), "JSON", doc, (r) => asJson(read(r, g))),
  /** A per-phase value (e.g. the parent connection id) — never null. */
  ctx: (name: string, doc: string, key: string) =>
    mk(name, utf8(), "VARCHAR", doc, (r) => r.__ctx?.[key] ?? null, false),
  /** LIST<STRUCT(...VARCHAR)> from an array of objects. */
  structList: (name: string, doc: string, fields: { name: string; path: string }[], g: Getter) =>
    mk(
      name,
      list(struct(fields.map((f) => field(f.name, utf8())) as never)),
      `STRUCT(${fields.map((f) => `${f.name} VARCHAR`).join(", ")})[]`,
      doc,
      (r) => {
        const v = read(r, g);
        if (!Array.isArray(v)) return null;
        return v.map((item) => Object.fromEntries(fields.map((f) => [f.name, asStr(at(item, f.path))])));
      },
    ),
};

// --------------------------------------------------------------------- the factory

/** The first request of one phase of a scan. */
export interface PhaseRequest {
  path: string;
  query?: Record<string, string | undefined>;
  /** Per-phase values exposed to columns through `C.ctx` (e.g. the connection id). */
  ctx?: Record<string, string>;
  /** Override the spec's `paged` for this request (e.g. GET one connection by id). */
  paged?: boolean;
}

export interface ScanContext {
  constraints: Constraint[];
  /** Wall-clock anchor fixed when the scan started (epoch ms), stable across resumes. */
  anchorMs: number;
}

export interface FnExample {
  sql: string;
  description: string;
}

export interface FivetranTableSpec {
  name: string;
  /** Schema the table lives in (default `main`). */
  schemaName?: string;
  description: string;
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
  columns: Col[];
  /** Columns that together identify a row (attested PRIMARY KEY); omit for none. */
  primaryKey?: string[];
  /** Columns that reference another table's `id` primary key in the same schema. */
  foreignKeys?: Record<string, string>;
  /** One request per phase; an empty list means the scan returns no rows (unused with `fanout`). */
  requests?: (ctx: ScanContext) => PhaseRequest[];
  /** False for endpoints that are not paged (single objects, schema config): no limit/cursor sent. */
  paged?: boolean;
  /** Pull the rows out of a response's `data` (default: `data.items`, or `data` itself when it is an object). */
  rows?: (data: unknown, ctx: Record<string, string>) => Row[];
  /**
   * Per-parent endpoints (sync history of a connection, members of a team …). `key` is an
   * output column; a pushed `WHERE key = 'x'` / `IN (…)` reads only those parents (no `key`:
   * the parents listing itself is narrowed, see `parents`), otherwise
   * every parent from `parents` is listed (paged) and each one's children are read in turn.
   * The pending parent ids and both cursors live in the scan state, so the fan-out resumes.
   */
  fanout?: {
    key?: string;
    parents: (scan: ScanContext) => PhaseRequest[];
    parentId: (row: Row) => string | null;
    /** The child request for one parent, or null to skip it. */
    child: (id: string, scan: ScanContext) => PhaseRequest | null;
  };
  /** A 404 means "no such object" → zero rows rather than an error. */
  notFoundEmpty?: boolean;
  /** Text appended to doc_md describing what pushes down. */
  pushdown: string;
  examples: FnExample[];
}

interface ScanState {
  phase: number;
  /** Fivetran `next_cursor` for the current phase; "" = start the phase. */
  cursor: string;
  anchorMs: number;
  /** Fan-out: pending parent ids, newline-joined (the head is being read). */
  queue: string;
  /** Fan-out: index into `fanout.parents` and that listing's cursor. */
  parentPhase: number;
  parentCursor: string;
  /** Fan-out: true once the explicit (pushed) parent list has been queued. */
  seeded: boolean;
}

/** Extract rows from `data`: `data.items` for lists, else the object itself. */
export function defaultRows(data: unknown): Row[] {
  if (Array.isArray(data)) return data as Row[];
  if (data && typeof data === "object") {
    const items = (data as { items?: unknown }).items;
    if (Array.isArray(items)) return items as Row[];
    return [data as Row];
  }
  return [];
}

function outputSchemaOf(spec: FivetranTableSpec) {
  return schema(
    spec.columns.map((c) =>
      c.sqlType === "JSON"
        ? field(c.name, c.type, c.nullable, new Map([["comment", c.doc], JSON_META]))
        : column(c.name, c.type, c.doc, c.nullable),
    ),
  );
}

function tagsOf(spec: FivetranTableSpec): Record<string, string> {
  return {
    domain: "data-integration",
    ...objectTags({
      title: spec.title,
      category: spec.category,
      keywords: spec.keywords,
      docLlm: spec.docLlm,
      docMd: `${spec.docMd}\n\n**Pushdown:** ${spec.pushdown}`,
    }),
    "vgi.result_columns_schema": JSON.stringify(
      spec.columns.map((c) => ({ name: c.name, type: c.sqlType, description: c.doc })),
    ),
    "vgi.example_queries": JSON.stringify(spec.examples),
  };
}

/** A Fivetran collection as a catalog table (`SELECT … FROM fivetran.main.connections`). */
export function defineFivetranTable(spec: FivetranTableSpec): TableDescriptor {
  const outSchema = outputSchemaOf(spec);
  const extract = spec.rows ?? defaultRows;
  const paged = spec.paged ?? true;
  const schemaPath = [spec.schemaName ?? "main"];

  const fn = defineTableFunction<Record<string, never>, ScanState>({
    name: `${spec.name}_scan`,
    description: spec.description,
    args: {},
    filterPushdown: true,
    // DuckDB drops pushed predicates from its plan; the SDK re-applies them exactly,
    // so translating a predicate only ever narrows what Fivetran returns.
    autoApplyFilters: true,
    onBind: (params) =>
      params.resolvedSecretsProvided
        ? { outputSchema: outSchema }
        : { outputSchema: outSchema, lookupSecretTypes: [SECRET_TYPE] },
    initialState: () => ({
      phase: 0,
      cursor: "",
      anchorMs: Date.now(),
      queue: "",
      parentPhase: 0,
      parentCursor: "",
      seeded: false,
    }),
    process: async (params, state, out) => {
      const cfg = configFromSecrets(params.secrets);
      const scan: ScanContext = { constraints: constraintsOf(params.pushdownFilters), anchorMs: state.anchorMs };
      log.debug(`${spec.name}: pushed filters ${formatPushedFilters(params.pushdownFilters)}`);

      const fetchPage = async (req: PhaseRequest, cursor: string) => {
        const isPaged = req.paged ?? paged;
        const query = isPaged ? { ...req.query, limit: String(cfg.pageSize), cursor: cursor || undefined } : req.query;
        try {
          return await fivetranGet(cfg, req.path, query);
        } catch (err) {
          if (spec.notFoundEmpty && err instanceof FivetranError && err.status === 404) {
            return { data: null, nextCursor: null };
          }
          throw err;
        }
      };
      /** Emit a page's rows; false when there were none (keep reading). */
      const emit = (data: unknown, ctx: Record<string, string>): boolean => {
        const rows = extract(data, ctx).map((r) => ({ ...r, __ctx: { ...ctx, ...r.__ctx } }));
        if (rows.length === 0) return false;
        const cols: Record<string, unknown[]> = {};
        for (const f of params.outputSchema.fields) {
          const c = spec.columns.find((x) => x.name === f.name);
          cols[f.name] = c ? rows.map((r) => c.get(r)) : rows.map(() => null);
        }
        out.emit(batchFromColumns(cols, params.outputSchema));
        return true;
      };

      const fan = spec.fanout;
      if (fan) {
        const explicit = fan.key ? eqValues(scan.constraints, fan.key) : undefined;
        if (explicit && !state.seeded) {
          state.queue = explicit.join("\n");
          state.parentPhase = -1; // never list parents
          state.seeded = true;
        }
        // Loop until a page yields rows or the scan ends, so no empty batches go out.
        for (;;) {
          if (!state.queue) {
            const parents = fan.parents(scan);
            const pp = parents[state.parentPhase];
            if (!pp) {
              out.finish();
              return;
            }
            const page = await fetchPage({ ...pp, paged: true }, state.parentCursor);
            if (page.nextCursor) state.parentCursor = page.nextCursor;
            else {
              state.parentPhase += 1;
              state.parentCursor = "";
            }
            state.queue = defaultRows(page.data)
              .map(fan.parentId)
              .filter((x): x is string => !!x)
              .join("\n");
            continue;
          }
          const ids = state.queue.split("\n");
          const id = ids[0] as string;
          const req = fan.child(id, scan);
          const advance = () => {
            state.queue = ids.slice(1).join("\n");
            state.cursor = "";
          };
          if (!req) {
            advance();
            continue;
          }
          const page = await fetchPage(req, state.cursor);
          if (page.nextCursor) state.cursor = page.nextCursor;
          else advance();
          if (emit(page.data, req.ctx ?? {})) return;
        }
      }

      const phases = spec.requests?.(scan) ?? [];
      for (;;) {
        const phase = phases[state.phase];
        if (!phase) {
          out.finish();
          return;
        }
        const page = await fetchPage(phase, state.cursor);
        if (page.nextCursor) state.cursor = page.nextCursor;
        else {
          state.phase += 1;
          state.cursor = "";
        }
        if (emit(page.data, phase.ctx ?? {})) return;
      }
    },
    tags: tagsOf(spec),
    examples: spec.examples,
  });

  const constraints: Uint8Array[] = [];
  for (const c of spec.columns) {
    if (!c.nullable) {
      constraints.push(
        constraintRecord({
          schemaPath,
          table: spec.name,
          id: `${c.name}_not_null`,
          kind: "NOT_NULL",
          columns: [[c.name]],
          enforcement: "ENFORCED",
          validation: "ALL_ROWS",
        }),
      );
    }
  }
  if (spec.primaryKey?.length) {
    constraints.push(
      constraintRecord({
        schemaPath,
        table: spec.name,
        id: "pk",
        kind: "PRIMARY_KEY",
        columns: spec.primaryKey.map((k) => [k]),
        enforcement: "ENFORCED",
        validation: "ALL_ROWS",
      }),
    );
  }

  for (const [col, target] of Object.entries(spec.foreignKeys ?? {})) {
    constraints.push(
      constraintRecord({
        schemaPath,
        table: spec.name,
        id: `${col}_fk`,
        kind: "FOREIGN_KEY",
        columns: [[col]],
        enforcement: "ENFORCED",
        validation: "ALL_ROWS",
        references: { schemaPath, table: target, columns: [["id"]], constraintId: "pk" },
      }),
    );
  }

  return {
    name: spec.name,
    comment: spec.description,
    columns: outSchema,
    function: fn,
    constraints,
    tags: tagsOf(spec),
  };
}
