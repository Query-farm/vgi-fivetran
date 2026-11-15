/**
 * Assemble the `fivetran` catalog: the `main` tables, `unified.runs`, and the
 * `fivetran` secret type.
 */

import { type CatalogDescriptor, field, int64, schema, type TableDescriptor, utf8 } from "@query-farm/vgi";
import { DEFAULT_BASE_URL, MAX_PAGE_SIZE, SECRET_TYPE } from "./fivetran/client.ts";
import { MAIN_TABLES, UNIFIED_TABLES } from "./fivetran/resources.ts";
import {
  CATALOG_COMMENT,
  CATALOG_NAME,
  CATALOG_TAGS,
  SCHEMA_DOC_MD,
  SCHEMA_TAGS,
  SOURCE_URL,
  UNIFIED_DOC_MD,
  UNIFIED_SCHEMA_TAGS,
} from "./meta.ts";

const doc = (text: string) => new Map([["vgi_doc", text]]);
const redacted = (text: string) =>
  new Map([
    ["redact", "true"],
    ["vgi_doc", text],
  ]);

/** CREATE SECRET (TYPE fivetran, API_KEY '…', API_SECRET '…'). */
export const FIVETRAN_SECRET_TYPE = {
  name: SECRET_TYPE,
  description: "Fivetran REST API key and secret (a user API key or a system key), sent as HTTP Basic auth",
  schema: schema(
    [
      field("api_key", utf8(), true, redacted("API key (Account Settings > API Key, or a system key's key).")),
      field("api_secret", utf8(), true, redacted("API secret paired with the key.")),
      field(
        "base_url",
        utf8(),
        true,
        doc(`REST API base URL; defaults to ${DEFAULT_BASE_URL} (http:// is accepted only for 127.0.0.1/localhost).`),
      ),
      field(
        "page_size",
        int64(),
        true,
        doc(`Rows requested per page (1..${MAX_PAGE_SIZE}, default ${MAX_PAGE_SIZE}).`),
      ),
    ],
    new Map([["vgi_doc_url", "https://fivetran.com/docs/rest-api/getting-started"]]),
  ),
};

interface Example {
  description: string;
  sql: string;
}
const examplesOf = (tables: TableDescriptor[]): Example[] =>
  tables.flatMap((t) => JSON.parse(t.tags?.["vgi.example_queries"] ?? "[]") as Example[]);

export const TABLES = [...MAIN_TABLES, ...UNIFIED_TABLES];

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_COMMENT,
  sourceUrl: SOURCE_URL,
  tags: CATALOG_TAGS,
  secretTypes: [FIVETRAN_SECRET_TYPE],
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_DOC_MD,
      functions: [],
      tables: MAIN_TABLES,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(examplesOf(MAIN_TABLES).slice(0, 12)) },
    },
    {
      path: ["unified"],
      comment: UNIFIED_DOC_MD,
      functions: [],
      tables: UNIFIED_TABLES,
      tags: { ...UNIFIED_SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(examplesOf(UNIFIED_TABLES)) },
    },
  ],
};
