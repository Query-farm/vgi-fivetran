/**
 * Discovery metadata: the one file to edit when you rename or extend the worker.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these
 * tags. Keep every object documented and `make lint-explain` stays at 100.
 *
 * - Catalog-level tags (title, license, author, links, long description) live in
 *   `CATALOG_TAGS` below.
 * - Every function carries `objectTags(...)`: a title, a category from
 *   `SCHEMA_CATEGORIES`, search keywords, and LLM- and human-facing docs.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "fivetran";
export const VERSION = "0.1.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-fivetran";

/**
 * Categories group objects in docs and agent tools. Every object's `vgi.category`
 * must name one of its schema's categories.
 */
export const SCHEMA_CATEGORIES = [
  {
    name: "connections",
    title: "Connections",
    description:
      "Connections (connectors), their schema/table/column config, state, errors, warnings and the connector catalogue.",
  },
  { name: "syncs", title: "Sync History", description: "Individual sync runs of each connection (last 7 days)." },
  { name: "destinations", title: "Destinations", description: "Groups, destinations and who can access them." },
  {
    name: "transformations",
    title: "Transformations",
    description: "dbt Core and Quickstart transformations and projects.",
  },
  {
    name: "account",
    title: "Account and Access",
    description: "The account, users, teams, memberships, roles and system keys.",
  },
  {
    name: "infrastructure",
    title: "Infrastructure",
    description: "Webhooks, hybrid deployment agents, private links, proxy agents and log services.",
  },
] as const;

export const UNIFIED_CATEGORIES = [
  {
    name: "unified",
    title: "Unified Orchestration",
    description: "Runs in the column shape shared by every orchestrator worker, for UNION ALL across tools.",
  },
] as const;

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"] | (typeof UNIFIED_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

const SOURCES_MD =
  "### Sources and references\n\n" +
  "- [Fivetran REST API reference](https://fivetran.com/docs/rest-api/api-reference) — the endpoints this worker reads\n" +
  "- [Authentication](https://fivetran.com/docs/rest-api/getting-started) — API key + secret, or a system key\n" +
  "- [Pagination](https://fivetran.com/docs/rest-api/pagination) — `cursor` / `limit`\n" +
  "- [Sync history](https://fivetran.com/docs/rest-api/api-reference/connections/connection-sync-history) — 7-day window\n" +
  "- [Fivetran Platform Connector](https://fivetran.com/docs/logs/fivetran-platform) — logs, MAR and usage (not in the REST API)";

export const CATALOG_COMMENT =
  "Fivetran's ELT control plane as SQL: connections and their sync status, schema config, sync history, " +
  "destinations, transformations, users and teams, read-only from the Fivetran REST API.";

export const CATALOG_DOC_LLM =
  "Read-only SQL access to a Fivetran account through the Fivetran REST API v1. Reach for it to monitor " +
  "and audit ELT pipelines: which connections are broken, paused, delayed or failing (connections: " +
  "setup_state, sync_state, update_state, succeeded_at, failed_at, tasks, warnings), what every sync did " +
  "over the last 7 days (syncs, and unified.runs in the cross-orchestrator shape), which source " +
  "schemas / tables / columns are enabled, blocked or hashed (connection_schemas, connection_tables, " +
  "connection_columns), connection state, errors and warnings, destinations and groups, dbt " +
  "transformations and projects, users, teams, memberships, roles, system keys, webhooks, hybrid " +
  "deployment agents, private links, proxy agents, log services and the connector-type catalogue. " +
  "Every table needs a `fivetran` DuckDB secret (API_KEY + API_SECRET of a user API key or a system key; " +
  "optional BASE_URL). WHERE filters push down where the API has them: connection id / group_id / " +
  "schema_name, per-connection tables on connection_id, users on active / user_type / has_api_key, " +
  "transformations on type / project_id, hybrid agents on group_id, sync history on started_at (the " +
  "API's start_time/end_time window). Per-connection tables without a connection_id filter make one call " +
  "per connection. Not available through the REST API: monthly active rows (MAR), usage and cost, " +
  "sync log events and transformation run history — use the Fivetran Platform Connector for those. " +
  "Docs: https://fivetran.com/docs/rest-api/api-reference .";

export const CATALOG_DOC_MD =
  "# Fivetran\n\n" +
  "Query a Fivetran account from DuckDB: connections and their health, schema/table/column " +
  "configuration (blocking and hashing), sync history, destinations, transformations, users, teams " +
  "and access, webhooks and hybrid deployment agents. Read-only.\n\n" +
  "Create a `fivetran` secret with an API key and secret (`API_KEY`, `API_SECRET`) — a user key or a " +
  "system key. Filters are translated into Fivetran path and query parameters where the API supports " +
  "them; cursor paging and HTTP 429 `Retry-After` are handled for you.\n\n" +
  "**Not in the REST API:** monthly active rows (MAR), usage/cost, log events and transformation run " +
  "history. Those come from the Fivetran Platform Connector.\n\n" +
  SOURCES_MD;

export const SCHEMA_DOC_LLM =
  "Fivetran REST API v1 collections as catalog tables. Account-wide collections (connections, users, " +
  "groups, destinations, transformations, …) are one paged listing each. Per-connection tables " +
  "(connection_schemas / _tables / _columns / _states / _errors / _warnings, syncs) and " +
  "per-team / per-user / per-group membership tables read one parent at a time: filter on the parent id " +
  "(= or IN) to read only those parents, otherwise every parent is listed first. syncs covers " +
  "the last 7 days only. All tables need a `fivetran` secret.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "Fivetran collections: connections and their configuration, sync history, destinations, " +
  "transformations, users and access, and infrastructure.\n\n" +
  "Per-connection tables take the connection from a `connection_id` filter, and otherwise read every " +
  "connection. All tables need a `fivetran` secret.";

export const UNIFIED_DOC_LLM =
  "Cross-orchestrator views. unified.runs has the exact column set every orchestration worker " +
  "(Airflow, Dagster, Prefect, Temporal, Databricks, dbt, GitHub, Fivetran) exposes, so their runs " +
  "UNION ALL into one table. Fivetran contributes its syncs (last 7 days). There is no " +
  "unified.task_runs: Fivetran syncs have extract/process/load volumes but no timed sub-tasks.";

export const UNIFIED_DOC_MD =
  "## unified\n\n" +
  "Fivetran syncs in the shared `unified.runs` shape, for UNION ALL with the runs of other " +
  "orchestration workers (Airflow, Dagster, Prefect, Temporal, Databricks, dbt, GitHub).\n\n" +
  "Each sync of the last 7 days is one run: `pipeline` is the connection's schema name, `status` is " +
  "mapped onto queued / running / success / failed / cancelled / skipped and `raw_status` keeps " +
  "Fivetran's own value.\n\n" +
  "There is no `unified.task_runs`: a Fivetran sync reports extract / process / load volumes but no " +
  "timed sub-tasks.";

export const AGENT_TEST_TASKS = [
  {
    name: "broken_connections",
    prompt: "Which Fivetran connections have a broken setup state? Give their schema names.",
  },
  { name: "paused_connections", prompt: "Which Fivetran connections are paused?" },
  { name: "open_tasks", prompt: "List the open user tasks (code and message) on Fivetran connections." },
  { name: "connections_per_group", prompt: "How many Fivetran connections does each group (by name) have?" },
  { name: "hashed_columns", prompt: "Which columns are hashed in the Salesforce connection's schema config?" },
  { name: "blocked_tables", prompt: "Which source tables are blocked (disabled) across all connections?" },
  { name: "failed_syncs", prompt: "How many syncs failed per connection in Fivetran's sync history?" },
  { name: "webhook_events", prompt: "Which active webhooks are subscribed to sync_end events?" },
  { name: "suspended_users", prompt: "Which Fivetran users are suspended (not active)?" },
  { name: "team_members", prompt: "Who are the members of the Data Engineering team?" },
  { name: "dbt_models", prompt: "Which models do the dbt Core transformations build?" },
  { name: "offline_agents", prompt: "Are any hybrid deployment agents offline?" },
  { name: "account_name", prompt: "What is the name and id of the Fivetran account behind this API key?" },
  { name: "connection_error_titles", prompt: "What errors are currently open on Fivetran connections, newest first?" },
  { name: "disabled_schemas", prompt: "Which source schemas are disabled in Fivetran connections?" },
  { name: "postgres_lsn", prompt: "What LSN is stored in the saved state of the c_postgres connection?" },
  {
    name: "warning_codes",
    prompt: "Which warning codes are raised on connection tables, and on how many tables each?",
  },
  { name: "database_sources", prompt: "Which Fivetran connector types in the catalogue are databases?" },
  {
    name: "broken_destinations",
    prompt: "Which Fivetran destinations are not connected, and what warehouse type are they?",
  },
  { name: "warehouse_users", prompt: "Which users have access to the Snowflake Warehouse group?" },
  { name: "log_destinations", prompt: "Where does Fivetran send its logs?" },
  { name: "private_link_states", prompt: "What state are the Fivetran private links in?" },
  { name: "proxy_status", prompt: "Are the Fivetran proxy agents connected?" },
  { name: "deprecated_roles", prompt: "Which Fivetran roles are deprecated, and what replaces them?" },
  { name: "manage_keys", prompt: "Which system keys have MANAGE access to any resource type?" },
  {
    name: "team_connection_grants",
    prompt: "Which connections has the Analytics team been granted, and with what role?",
  },
  {
    name: "team_destination_roles",
    prompt: "Which groups (destinations) does the Data Engineering team have a role on?",
  },
  { name: "project_groups", prompt: "Which group does each dbt transformation project build in?" },
  { name: "user_connection_roles", prompt: "Which connections has grace@acme.example been given a direct role on?" },
  { name: "user_destination_roles", prompt: "Which destination groups does ada@acme.example have a direct role on?" },
  {
    name: "unified_failed_runs",
    prompt: "In the cross-orchestrator unified runs view, how many Fivetran runs failed per pipeline?",
  },
];

/** Bind-only probes: each binds a table and shows its columns without fetching (LIMIT 0). */
export const EXECUTABLE_EXAMPLES = [
  {
    name: "connections_columns",
    description:
      "The connections table's status columns (binds only; create a fivetran secret and drop LIMIT 0 for rows)",
    sql: "SELECT id, service, setup_state, sync_state, succeeded_at, failed_at FROM fivetran.main.connections LIMIT 0",
  },
  {
    name: "runs_columns",
    description: "The unified.runs columns (binds only; create a fivetran secret and drop LIMIT 0 for rows)",
    sql: "SELECT orchestrator, run_id, pipeline, status, started_at FROM fivetran.unified.runs LIMIT 0",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Fivetran ELT",
  "vgi.subtitle":
    "Fivetran connections, sync status and history, schema config, destinations, transformations and access as SQL tables.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC - https://query.farm",
  "vgi.keywords": keywordsArray(
    "fivetran, elt, etl, data integration, connectors, connections, sync status, sync history, schema config, column hashing, destinations, dbt, transformations, data pipelines, observability",
  ),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
  "vgi.executable_examples": JSON.stringify(EXECUTABLE_EXAMPLES),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Fivetran REST API",
  domain: "data-integration",
  "vgi.keywords": keywordsArray(
    "fivetran, connections, sync history, schema config, destinations, transformations, users, teams",
  ),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};

export const UNIFIED_SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Unified Orchestration Runs",
  domain: "data-integration",
  "vgi.keywords": keywordsArray("unified, runs, orchestrator, cross-tool, union, pipelines"),
  "vgi.doc_llm": UNIFIED_DOC_LLM,
  "vgi.doc_md": UNIFIED_DOC_MD,
  "vgi.categories": JSON.stringify(UNIFIED_CATEGORIES),
};
