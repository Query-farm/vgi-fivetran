/**
 * The Fivetran tables: one spec per REST API v1 collection.
 *
 * Column names follow Fivetran's own fields (snake_case already), with `_at` timestamps as
 * TIMESTAMPTZ, ids as VARCHAR, booleans as BOOLEAN and the per-connection status object
 * flattened. Endpoint reference: https://fivetran.com/docs/rest-api/api-reference
 */

import type { TableDescriptor } from "@query-farm/vgi";
import { type Constraint, eqValues, timeBounds } from "./pushdown.ts";
import { asStr, C, type Col, defineFivetranTable, type PhaseRequest, type Row } from "./table.ts";

const Q = "fivetran.main";
const enc = encodeURIComponent;
const DAY_MS = 86_400_000;

/** The Fivetran dashboard page of a connection. */
export const dashboardUrl = (connectionId: string) =>
  `https://fivetran.com/dashboard/connections/${enc(connectionId)}/status`;

const FANOUT_NOTE =
  "Without a pushed connection filter it lists every connection first and then makes one more API " +
  "call per connection, so filter on connection_id (= or IN) when you can.";

/** Pushed `= true` on a boolean column. */
function isTrue(cs: Constraint[], column: string): boolean {
  return cs.some((c) => c.kind === "cmp" && c.column === column && c.op === "eq" && c.value === true);
}
/** A single pushed boolean equality on a column (true / false), else undefined. */
function boolEq(cs: Constraint[], column: string): boolean | undefined {
  const vs = cs.filter((c) => c.kind === "cmp" && c.column === column && c.op === "eq");
  const vals = new Set(vs.map((c) => (c.kind === "cmp" ? c.value : undefined)));
  if (vals.size !== 1) return undefined;
  const v = [...vals][0];
  return typeof v === "boolean" ? v : undefined;
}
/** A single pushed string equality on a column, else undefined. */
function oneValue(cs: Constraint[], column: string): string | undefined {
  const vs = eqValues(cs, column);
  return vs && vs.length === 1 ? vs[0] : undefined;
}

// ----------------------------------------------------------------------- masking

const SENSITIVE = /pass|secret|token|private|credential|api_?key|access_?key|auth_?code|pem|certificate|signature/i;

/** Replace sensitive-looking string values in a connection's config with `******`. */
export function maskConfig(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => maskConfig(x, key));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, maskConfig(x, k)]));
  }
  if (typeof v === "string" && v !== "" && SENSITIVE.test(key)) return "******";
  return v;
}

// ---------------------------------------------------------------------- account

const account = defineFivetranTable({
  name: "accounts",
  description: "The Fivetran account the API key belongs to (one row)",
  title: "Fivetran Account",
  category: "account",
  keywords: "fivetran, account, account id, api key owner, whoami",
  docLlm:
    "One row describing the account and principal behind the secret (GET /v1/account/info): id (the account id), " +
    "account_name, user_id (the key's user) and system_key_id (set when a system key is used). Use it to " +
    "check which account a secret points at. Join user_id to users.id for the key owner and system_key_id to " +
    "system_keys.id for the system key's permissions.",
  docMd:
    "## accounts\n\nThe Fivetran account behind the configured API key: id, name, and the calling user or system key.",
  pushdown: "none (a single request).",
  paged: false,
  columns: [
    C.str("id", "Fivetran account id.", "account_id", false),
    C.str("account_name", "Display name of the Fivetran account.", "account_name"),
    C.str("user_id", "Id of the user who owns the API key (NULL for a system key).", "user_id"),
    C.str("system_key_id", "Id of the system key in use (NULL for a user key).", "system_key_id"),
  ],
  primaryKey: ["id"],
  foreignKeys: { user_id: "users", system_key_id: "system_keys" },
  requests: () => [{ path: "/v1/account/info" }],
  examples: [{ sql: `SELECT id, account_name FROM ${Q}.accounts`, description: "Which account the secret points at" }],
});

// ------------------------------------------------------------------------ users

function userColumns(idName = "id"): Col[] {
  return [
    C.str(idName, "Fivetran user id.", "id", false),
    C.str("email", "Email address.", "email"),
    C.str("given_name", "First name.", "given_name"),
    C.str("family_name", "Last name.", "family_name"),
    C.str("role", "Account-level role, e.g. Account Administrator (NULL when none).", "role"),
    C.bool("active", "True when the user is enabled (allowed to log in); false when suspended.", "active"),
    C.bool("verified", "Whether the email address is verified.", "verified"),
    C.bool("invited", "Whether the user has a pending invitation.", "invited"),
    C.str("user_type", "REGULAR_USER (a human) or SERVICE_ACCOUNT.", "user_type"),
    C.bool("has_api_key", "Whether the user has an API key (including expired ones).", "has_api_key"),
    C.str("phone", "Phone number.", "phone"),
    C.time("logged_in_at", "Last dashboard login.", "logged_in_at"),
    C.time("created_at", "When the user was created.", "created_at"),
  ];
}

/** active=true / user_type / has_api_key → the users list's query parameters. */
function userQuery(cs: Constraint[]): Record<string, string | undefined> {
  const hk = boolEq(cs, "has_api_key");
  return {
    active: isTrue(cs, "active") ? "true" : undefined,
    user_type: oneValue(cs, "user_type"),
    has_api_key: hk === undefined ? undefined : String(hk),
  };
}

const users = defineFivetranTable({
  name: "users",
  description: "Users of the Fivetran account with their roles and login status",
  title: "Fivetran Users",
  category: "account",
  keywords: "fivetran, users, people, members, service accounts, roles, api keys, login",
  docLlm:
    "Every user of the account (GET /v1/users): id, email, names, account role, active (enabled vs " +
    "suspended), verified, invited, user_type (REGULAR_USER or SERVICE_ACCOUNT), has_api_key, " +
    "logged_in_at and created_at. WHERE active = true, user_type = '…' and has_api_key = true/false are " +
    "sent to Fivetran as query parameters.",
  docMd: "## users\n\nUsers of the account, one row each, with their account role and login status.",
  pushdown:
    "`active = true` → `active=true`; `user_type = '…'` → `user_type`; `has_api_key = true/false` → `has_api_key`.",
  columns: userColumns(),
  primaryKey: ["id"],
  requests: ({ constraints }) => [{ path: "/v1/users", query: userQuery(constraints) }],
  examples: [
    {
      sql: `SELECT email, role, logged_in_at FROM ${Q}.users WHERE active AND user_type = 'REGULAR_USER' ORDER BY logged_in_at DESC NULLS LAST`,
      description: "Enabled human users by most recent login (both filters push down)",
    },
    {
      sql: `SELECT email FROM ${Q}.users WHERE has_api_key AND user_type = 'SERVICE_ACCOUNT' ORDER BY email`,
      description: "Service accounts holding API keys",
    },
  ],
});

// ------------------------------------------------------------------------ teams

const teams = defineFivetranTable({
  name: "teams",
  description: "Teams in the Fivetran account and their account-level roles",
  title: "Fivetran Teams",
  category: "account",
  keywords: "fivetran, teams, rbac, permissions, roles",
  docLlm: "Every team (GET /v1/teams): id, name, description and the team's account-level role.",
  docMd: "## teams\n\nTeams in the account with their account-level role.",
  pushdown: "none (the endpoint has no filters); the SDK applies WHERE locally.",
  columns: [
    C.str("id", "Team id.", "id", false),
    C.str("name", "Team name.", "name"),
    C.str("description", "Team description.", "description"),
    C.str("role", "The team's account-level role (NULL when none).", "role"),
  ],
  primaryKey: ["id"],
  requests: () => [{ path: "/v1/teams" }],
  examples: [{ sql: `SELECT name, role FROM ${Q}.teams ORDER BY name`, description: "Teams and their account roles" }],
});

const ALL_TEAMS = (): PhaseRequest[] => [{ path: "/v1/teams" }];
const ALL_USERS = (): PhaseRequest[] => [{ path: "/v1/users" }];
const ALL_GROUPS = (): PhaseRequest[] => [{ path: "/v1/groups" }];
const ALL_CONNECTIONS = (): PhaseRequest[] => [{ path: "/v1/connections" }];
const idOf = (r: Row) => asStr(r.id);

function membership(opts: {
  name: string;
  parent: "team" | "user";
  kind: "users" | "groups" | "connections";
  title: string;
  description: string;
  docLlm: string;
  example: { sql: string; description: string };
}) {
  const parentKey = `${opts.parent}_id`;
  const memberKey = opts.kind === "users" ? "user_id" : opts.kind === "groups" ? "group_id" : "connection_id";
  return defineFivetranTable({
    name: opts.name,
    description: opts.description,
    title: opts.title,
    category: "account",
    keywords: `fivetran, ${opts.parent} membership, ${opts.kind}, roles, permissions, rbac, access review`,
    docLlm: `${opts.docLlm} Filter on ${parentKey} (= or IN) to read only those ${opts.parent}s; otherwise every ${opts.parent} is listed and read (one call each).`,
    docMd: `## ${opts.name}\n\n${opts.description}: one row per membership with its role.`,
    pushdown: `\`${parentKey}\` (= / IN) selects which ${opts.parent}s are read (path parameter).`,
    columns: [
      C.ctx(parentKey, `The ${opts.parent} id.`, "parent"),
      C.str(memberKey, `The member ${opts.kind.slice(0, -1)} id.`, opts.kind === "users" ? "user_id" : "id", false),
      C.str("role", "The role granted by this membership.", "role"),
      C.time("created_at", "When the membership was created.", "created_at"),
    ],
    primaryKey: [parentKey, memberKey],
    foreignKeys: { [parentKey]: `${opts.parent}s`, [memberKey]: opts.kind },
    notFoundEmpty: true,
    fanout: {
      key: parentKey,
      parents: opts.parent === "team" ? ALL_TEAMS : ALL_USERS,
      parentId: idOf,
      child: (id) => ({ path: `/v1/${opts.parent}s/${enc(id)}/${opts.kind}`, ctx: { parent: id } }),
    },
    examples: [opts.example],
  });
}

const teamUsers = membership({
  name: "team_users",
  parent: "team",
  kind: "users",
  title: "Fivetran Team Members",
  description: "Users who belong to each Fivetran team, with their team role",
  docLlm: "Team membership (GET /v1/teams/{id}/users): team_id, user_id, the user's role in the team, created_at.",
  example: {
    sql: `SELECT t.name AS team, u.email, m.role FROM ${Q}.team_users m JOIN ${Q}.teams t ON t.id = m.team_id JOIN ${Q}.users u ON u.id = m.user_id ORDER BY team, u.email`,
    description: "Who is in which team",
  },
});
const teamGroups = membership({
  name: "team_groups",
  parent: "team",
  kind: "groups",
  title: "Fivetran Team Destination Access",
  description: "Groups (destinations) each team has a role on",
  docLlm: "Team access to groups/destinations (GET /v1/teams/{id}/groups): team_id, group_id, role, created_at.",
  example: {
    sql: `SELECT team_id, group_id, role FROM ${Q}.team_groups WHERE team_id = 't_data_eng' ORDER BY group_id`,
    description: "Destination roles of one team (team_id pushes down)",
  },
});
const teamConnections = membership({
  name: "team_connections",
  parent: "team",
  kind: "connections",
  title: "Fivetran Team Connection Access",
  description: "Connections each team has a role on",
  docLlm:
    "Team access to individual connections (GET /v1/teams/{id}/connections): team_id, connection_id, role, created_at.",
  example: {
    sql: `SELECT team_id, count(*) AS connections FROM ${Q}.team_connections GROUP BY team_id ORDER BY connections DESC`,
    description: "Connection grants per team",
  },
});
const userGroups = membership({
  name: "user_groups",
  parent: "user",
  kind: "groups",
  title: "Fivetran User Destination Access",
  description: "Groups (destinations) each user has a direct role on",
  docLlm: "A user's direct group/destination roles (GET /v1/users/{id}/groups): user_id, group_id, role, created_at.",
  example: {
    sql: `SELECT u.email, g.name AS destination_group, m.role FROM ${Q}.user_groups m JOIN ${Q}.users u ON u.id = m.user_id JOIN ${Q}.groups g ON g.id = m.group_id ORDER BY u.email`,
    description: "Direct destination roles per user",
  },
});
const userConnections = membership({
  name: "user_connections",
  parent: "user",
  kind: "connections",
  title: "Fivetran User Connection Access",
  description: "Connections each user has a direct role on",
  docLlm:
    "A user's direct connection roles (GET /v1/users/{id}/connections): user_id, connection_id, role, created_at.",
  example: {
    sql: `SELECT user_id, connection_id, role FROM ${Q}.user_connections WHERE user_id = 'u_grace' ORDER BY connection_id`,
    description: "Connections one user can manage (user_id pushes down)",
  },
});

// ----------------------------------------------------------------------- groups

const groups = defineFivetranTable({
  name: "groups",
  description: "Groups: each Fivetran destination and the connections that load into it",
  title: "Fivetran Groups",
  category: "destinations",
  keywords: "fivetran, groups, destinations, warehouses, workspaces",
  docLlm:
    "Every group (GET /v1/groups): id, name, created_at. In Fivetran a group is the container of one " +
    "destination and its connections; groups.id equals destinations.id and connections.group_id.",
  docMd: "## groups\n\nGroups (one per destination) with their names.",
  pushdown: "none (the endpoint has no filters); the SDK applies WHERE locally.",
  columns: [
    C.str("id", "Group id (equals the destination id).", "id", false),
    C.str("name", "Group name.", "name"),
    C.time("created_at", "When the group was created.", "created_at"),
  ],
  primaryKey: ["id"],
  requests: ALL_GROUPS,
  examples: [
    {
      sql: `SELECT g.name, count(c.id) AS connections FROM ${Q}.groups g LEFT JOIN ${Q}.connections c ON c.group_id = g.id GROUP BY g.name ORDER BY connections DESC`,
      description: "Connection count per group",
    },
  ],
});

const groupUsers = defineFivetranTable({
  name: "group_users",
  description: "Users with access to each group (destination)",
  title: "Fivetran Group Users",
  category: "destinations",
  keywords: "fivetran, group users, destination access, members, access review",
  docLlm:
    "Users who have access to a group/destination (GET /v1/groups/{id}/users): group_id plus the user " +
    "columns (email, names, account role, active, user_type, …). Filter on group_id (= or IN) to read only " +
    "those groups, otherwise every group is read. WHERE active = true is sent as active=true.",
  docMd: "## group_users\n\nUsers with access to each group, with their account details.",
  pushdown: "`group_id` (= / IN) selects groups (path parameter); `active = true` → `active=true`.",
  columns: [C.ctx("group_id", "The group id.", "group_id"), ...userColumns("user_id")],
  primaryKey: ["group_id", "user_id"],
  foreignKeys: { group_id: "groups", user_id: "users" },
  notFoundEmpty: true,
  fanout: {
    key: "group_id",
    parents: ALL_GROUPS,
    parentId: idOf,
    child: (id, { constraints }) => ({
      path: `/v1/groups/${enc(id)}/users`,
      query: { active: isTrue(constraints, "active") ? "true" : undefined },
      ctx: { group_id: id },
    }),
  },
  examples: [
    {
      sql: `SELECT email, role FROM ${Q}.group_users WHERE group_id = 'g_warehouse' AND active ORDER BY email`,
      description: "Active users of one destination group (both filters push down)",
    },
  ],
});

// ----------------------------------------------------------------- destinations

const destinations = defineFivetranTable({
  name: "destinations",
  description: "Destinations (warehouses and lakes) Fivetran loads into",
  title: "Fivetran Destinations",
  category: "destinations",
  keywords: "fivetran, destinations, warehouses, snowflake, bigquery, databricks, redshift, region",
  docLlm:
    "Every destination (GET /v1/destinations): id (= its group id), group_id, service (snowflake, " +
    "big_query, databricks, …), region, setup_status (CONNECTED / INCOMPLETE / BROKEN), time zone, " +
    "networking_method and the private link / hybrid deployment agent / proxy agent ids. Connection " +
    "credentials (config) are not exposed. Join group_id to groups.id, private_link_id to private_links.id, " +
    "hybrid_deployment_agent_id to hybrid_deployment_agents.id and proxy_agent_id to proxy_agents.id.",
  docMd: "## destinations\n\nDestinations with their warehouse type, region, setup status and networking.",
  pushdown: "none (the endpoint has no filters); the SDK applies WHERE locally.",
  columns: [
    C.str("id", "Destination id (equals its group id).", "id", false),
    C.str("group_id", "The group the destination belongs to.", "group_id"),
    C.str("service", "Destination type, e.g. snowflake, big_query, databricks, redshift.", "service"),
    C.str("region", "Fivetran processing region, e.g. AWS_US_EAST_1.", "region"),
    C.str("setup_status", "CONNECTED, INCOMPLETE or BROKEN.", "setup_status"),
    C.str("time_zone_offset", "Time zone offset for daily syncs, e.g. -5.", "time_zone_offset"),
    C.bool(
      "daylight_saving_time_enabled",
      "Whether daylight saving time adjusts the offset.",
      "daylight_saving_time_enabled",
    ),
    C.str("networking_method", "Directly, PrivateLink, SshTunnel or ProxyAgent.", "networking_method"),
    C.str("private_link_id", "Private link used, if any.", "private_link_id"),
    C.str("hybrid_deployment_agent_id", "Hybrid deployment agent used, if any.", "hybrid_deployment_agent_id"),
    C.str("proxy_agent_id", "Proxy agent used, if any.", "proxy_agent_id"),
  ],
  primaryKey: ["id"],
  foreignKeys: {
    group_id: "groups",
    private_link_id: "private_links",
    hybrid_deployment_agent_id: "hybrid_deployment_agents",
    proxy_agent_id: "proxy_agents",
  },
  requests: () => [{ path: "/v1/destinations" }],
  examples: [
    {
      sql: `SELECT id, service, region FROM ${Q}.destinations WHERE setup_status <> 'CONNECTED' ORDER BY id`,
      description: "Destinations that are broken or incomplete",
    },
  ],
});

// ------------------------------------------------------------------ connections

const STATUS_ITEM = [
  { name: "code", path: "code" },
  { name: "message", path: "message" },
  { name: "details", path: "details" },
];

const connections = defineFivetranTable({
  name: "connections",
  description: "Connections (connectors): source, schedule and sync status",
  title: "Fivetran Connections",
  category: "connections",
  keywords:
    "fivetran, connections, connectors, sources, sync status, setup state, sync state, paused, broken, schedule, sync frequency, elt",
  docLlm:
    "Every connection, formerly called connector (GET /v1/connections): id, group_id, service (source " +
    "type), schema_name (the destination schema prefix that names the connection), paused, " +
    "sync_frequency (minutes), schedule_type, daily_sync_time, the flattened status (setup_state " +
    "connected/incomplete/broken, sync_state scheduled/syncing/paused/rescheduled, update_state " +
    "on_schedule/delayed, schema_status, is_historical_sync, rescheduled_for), succeeded_at and " +
    "failed_at (last successful / failed sync), tasks and warnings (`LIST` of `STRUCT` code/message/details " +
    "— tasks are actions a user must take), networking ids, a dashboard url and config as JSON with " +
    "secret-looking values masked. A connection is failing when failed_at > succeeded_at (or " +
    "succeeded_at IS NULL). WHERE id = / IN fetches those connections directly; group_id = / IN and " +
    "schema_name = push down as query parameters. service has no API filter and is applied locally. " +
    "Join group_id to groups.id (and destinations.id), service to connector_types.id, and " +
    "hybrid_deployment_agent_id / proxy_agent_id / private_link_id to those tables' id.",
  docMd:
    "## connections\n\nConnections with source type, schedule, setup/sync state, last success and failure, and open tasks.",
  pushdown:
    "`id` (= / IN) → GET /v1/connections/{id}; `group_id` (= / IN) → `group_id`; `schema_name =` → `schema`. `service` and the status columns are filtered locally.",
  columns: [
    C.str("id", "Connection id.", "id", false),
    C.str("group_id", "Group (destination) the connection loads into.", "group_id"),
    C.str("service", "Source type, e.g. salesforce, postgres_rds, google_sheets.", "service"),
    C.int(
      "service_version",
      "Connector implementation version number (an integer that increases with upgrades).",
      "service_version",
    ),
    C.str("schema_name", "Destination schema name (prefix) — the connection's name in the dashboard.", "schema"),
    C.bool("paused", "Whether syncing is paused.", "paused"),
    C.str("setup_state", "connected, incomplete or broken.", "status.setup_state"),
    C.str("sync_state", "scheduled, syncing, paused or rescheduled.", "status.sync_state"),
    C.str("update_state", "on_schedule or delayed (data is late).", "status.update_state"),
    C.str("schema_status", "Schema discovery status, e.g. ready, blocked_on_capture.", "status.schema_status"),
    C.bool("is_historical_sync", "True while the initial / re-sync of all history runs.", "status.is_historical_sync"),
    C.time("rescheduled_for", "When a rescheduled sync will run.", "status.rescheduled_for"),
    C.time("succeeded_at", "Last successful sync.", "succeeded_at"),
    C.time("failed_at", "Last failed sync.", "failed_at"),
    C.int(
      "sync_frequency",
      "Sync interval in minutes (5, 15, 30, 60, 120, 180, 360, 480, 720, 1440).",
      "sync_frequency",
    ),
    C.str("schedule_type", "auto (Fivetran schedules) or manual (API/trigger only).", "schedule_type"),
    C.str("daily_sync_time", "Time of day for 24-hour syncs, e.g. 02:00.", "daily_sync_time"),
    C.int("data_delay_threshold", "Custom delay threshold in minutes for update_state.", "data_delay_threshold"),
    C.str("data_delay_sensitivity", "LOW, NORMAL, HIGH, CUSTOM or SYNC_FREQUENCY.", "data_delay_sensitivity"),
    C.bool("pause_after_trial", "Whether the connection pauses when its trial ends.", "pause_after_trial"),
    C.structList(
      "tasks",
      "Actions a user must take (e.g. reconnect), as {code, message, details}.",
      STATUS_ITEM,
      "status.tasks",
    ),
    C.structList("warnings", "Non-blocking warnings, as {code, message, details}.", STATUS_ITEM, "status.warnings"),
    C.str("connected_by", "Id of the user who created the connection.", "connected_by"),
    C.time("created_at", "When the connection was created.", "created_at"),
    C.str("networking_method", "Directly, SshTunnel, PrivateLink, ProxyAgent, …", "networking_method"),
    C.str(
      "hybrid_deployment_agent_id",
      "Hybrid deployment agent running this connection, if any.",
      "hybrid_deployment_agent_id",
    ),
    C.str("proxy_agent_id", "Proxy agent used, if any.", "proxy_agent_id"),
    C.str("private_link_id", "Private link used, if any.", "private_link_id"),
    C.bool("data_checks", "Whether data checks are enabled.", "data_checks"),
    C.json("config", "Source configuration as JSON; passwords, tokens, keys and secrets are masked.", (r) =>
      r.config === undefined ? undefined : maskConfig(r.config),
    ),
    C.str("url", "Link to the connection's status page in the Fivetran dashboard.", (r) =>
      typeof r.id === "string" ? dashboardUrl(r.id) : null,
    ),
  ],
  primaryKey: ["id"],
  foreignKeys: {
    group_id: "groups",
    private_link_id: "private_links",
    hybrid_deployment_agent_id: "hybrid_deployment_agents",
    proxy_agent_id: "proxy_agents",
  },
  notFoundEmpty: true,
  requests: ({ constraints }) => {
    const ids = eqValues(constraints, "id");
    if (ids) return ids.map((id) => ({ path: `/v1/connections/${enc(id)}`, paged: false }));
    const schema = oneValue(constraints, "schema_name");
    const groupIds = eqValues(constraints, "group_id");
    if (groupIds) return groupIds.map((g) => ({ path: "/v1/connections", query: { group_id: g, schema } }));
    return [{ path: "/v1/connections", query: { schema } }];
  },
  examples: [
    {
      sql: `SELECT schema_name, service, setup_state, failed_at FROM ${Q}.connections WHERE NOT paused AND (setup_state <> 'connected' OR failed_at > coalesce(succeeded_at, TIMESTAMPTZ '1970-01-01')) ORDER BY failed_at DESC`,
      description: "Active connections that are broken or whose last sync failed",
    },
    {
      sql: `SELECT schema_name, t.code, t.message FROM ${Q}.connections, unnest(tasks) AS u(t) WHERE group_id = 'g_lake' ORDER BY schema_name`,
      description: "Open user tasks in one group (group_id pushes down)",
    },
  ],
});

// ----------------------------------------------------- connection schema config

/** Flatten a schema-config response into schema / table / column rows. */
type Level = "schema" | "table" | "column";
function flattenSchemaConfig(level: Level) {
  return (data: unknown): Row[] => {
    if (!data || typeof data !== "object") return [];
    const d = data as Row;
    const out: Row[] = [];
    for (const [schemaName, s] of Object.entries((d.schemas ?? {}) as Record<string, Row>)) {
      const tables = Object.entries((s?.tables ?? {}) as Record<string, Row>);
      if (level === "schema") {
        out.push({
          schema_name: schemaName,
          ...s,
          table_count: tables.length,
          enabled_table_count: tables.filter(([, t]) => t?.enabled === true).length,
          enable_new_by_default: d.enable_new_by_default,
          schema_change_handling: d.schema_change_handling,
        });
        continue;
      }
      for (const [tableName, t] of tables) {
        const cols = Object.entries((t?.columns ?? {}) as Record<string, Row>);
        if (level === "table") {
          out.push({
            schema_name: schemaName,
            table_name: tableName,
            schema_enabled: s?.enabled,
            ...t,
            column_count: cols.length,
          });
          continue;
        }
        for (const [columnName, c] of cols) {
          out.push({
            schema_name: schemaName,
            table_name: tableName,
            column_name: columnName,
            table_enabled: t?.enabled,
            ...c,
          });
        }
      }
    }
    return out;
  };
}

const CONNECTION_FANOUT = (child: (id: string) => Omit<PhaseRequest, "ctx">) => ({
  key: "connection_id",
  parents: ALL_CONNECTIONS,
  parentId: idOf,
  child: (id: string) => ({ ...child(id), ctx: { connection_id: id } }),
});
const connectionIdCol = () => C.ctx("connection_id", "The connection id.", "connection_id");
const patchCols = () => [
  C.bool(
    "patch_allowed",
    "Whether the enabled flag can be changed (enabled_patch_settings.allowed).",
    "enabled_patch_settings.allowed",
  ),
  C.str(
    "patch_reason_code",
    "Why it cannot be changed: SYSTEM_TABLE, SYSTEM_COLUMN, DELETED, OTHER.",
    "enabled_patch_settings.reason_code",
  ),
  C.str("patch_reason", "Human-readable reason it cannot be changed.", "enabled_patch_settings.reason"),
];

const connectionSchemas = defineFivetranTable({
  name: "connection_schemas",
  description: "Source schemas of each connection and whether they sync",
  title: "Fivetran Connection Schemas",
  category: "connections",
  keywords: "fivetran, schema config, source schemas, enabled, blocked, schema change handling",
  docLlm:
    "One row per source schema in a connection's schema config (GET /v1/connections/{id}/schemas): " +
    "connection_id, schema_name, name_in_destination, enabled, table_count, enabled_table_count and the " +
    "connection-wide enable_new_by_default and schema_change_handling (ALLOW_ALL / ALLOW_COLUMNS / " +
    `BLOCK_ALL). ${FANOUT_NOTE}`,
  docMd: "## connection_schemas\n\nSource schemas per connection with enablement and table counts.",
  pushdown: "`connection_id` (= / IN) selects which connections are read (path parameter).",
  paged: false,
  notFoundEmpty: true,
  foreignKeys: { connection_id: "connections" },
  columns: [
    connectionIdCol(),
    C.str("schema_name", "Source schema name.", "schema_name", false),
    C.str("name_in_destination", "Schema name in the destination.", "name_in_destination"),
    C.bool("enabled", "Whether the schema syncs.", "enabled"),
    C.int("table_count", "Count of tables listed in the schema config.", "table_count"),
    C.int("enabled_table_count", "Count of tables in the schema that sync (enabled).", "enabled_table_count"),
    C.bool(
      "enable_new_by_default",
      "Connection setting: new schemas/tables are enabled automatically.",
      "enable_new_by_default",
    ),
    C.str(
      "schema_change_handling",
      "Connection setting: ALLOW_ALL, ALLOW_COLUMNS or BLOCK_ALL.",
      "schema_change_handling",
    ),
  ],
  primaryKey: ["connection_id", "schema_name"],
  rows: flattenSchemaConfig("schema"),
  fanout: CONNECTION_FANOUT((id) => ({ path: `/v1/connections/${enc(id)}/schemas` })),
  examples: [
    {
      sql: `SELECT connection_id, schema_name, enabled_table_count, table_count FROM ${Q}.connection_schemas WHERE connection_id = 'c_postgres' ORDER BY schema_name`,
      description: "Schema enablement of one connection",
    },
  ],
});

const connectionTables = defineFivetranTable({
  name: "connection_tables",
  description: "Source tables of each connection: enabled or blocked, sync mode",
  title: "Fivetran Connection Tables",
  category: "connections",
  keywords: "fivetran, schema config, tables, blocked tables, enabled, sync mode, history mode, soft delete",
  docLlm:
    "One row per table in a connection's schema config (GET /v1/connections/{id}/schemas, flattened): " +
    "connection_id, schema_name, table_name, name_in_destination, enabled (false = blocked), " +
    "schema_enabled, sync_mode (SOFT_DELETE / HISTORY / LIVE), supports_columns_config, " +
    "supports_history_mode, patch_allowed / patch_reason_code / patch_reason (why it cannot be toggled), " +
    `parent_table and column_count. ${FANOUT_NOTE}`,
  docMd: "## connection_tables\n\nEvery table in each connection's schema config with enablement and sync mode.",
  pushdown: "`connection_id` (= / IN) selects which connections are read (path parameter).",
  paged: false,
  notFoundEmpty: true,
  foreignKeys: { connection_id: "connections" },
  columns: [
    connectionIdCol(),
    C.str("schema_name", "Source schema name.", "schema_name", false),
    C.str("table_name", "Source table name.", "table_name", false),
    C.str("name_in_destination", "Table name in the destination.", "name_in_destination"),
    C.bool("enabled", "Whether the table syncs (false = blocked).", "enabled"),
    C.bool("schema_enabled", "Whether the table's schema syncs.", "schema_enabled"),
    C.str("sync_mode", "SOFT_DELETE, HISTORY or LIVE.", "sync_mode"),
    C.bool("supports_columns_config", "Whether columns can be configured individually.", "supports_columns_config"),
    C.bool("supports_history_mode", "Whether history mode is available.", "supports_history_mode"),
    ...patchCols(),
    C.str("parent_table", "Parent table for child tables.", "parent_table"),
    C.int("column_count", "Columns listed in the schema config for this table.", "column_count"),
  ],
  primaryKey: ["connection_id", "schema_name", "table_name"],
  rows: flattenSchemaConfig("table"),
  fanout: CONNECTION_FANOUT((id) => ({ path: `/v1/connections/${enc(id)}/schemas` })),
  examples: [
    {
      sql: `SELECT connection_id, schema_name, table_name FROM ${Q}.connection_tables WHERE NOT enabled ORDER BY ALL`,
      description: "Blocked (disabled) tables across all connections",
    },
    {
      sql: `SELECT sync_mode, count(*) AS tables FROM ${Q}.connection_tables WHERE enabled GROUP BY sync_mode ORDER BY tables DESC`,
      description: "Enabled tables by sync mode",
    },
  ],
});

const connectionColumns = defineFivetranTable({
  name: "connection_columns",
  description: "Configured columns of each connection: blocked, hashed, primary key",
  title: "Fivetran Connection Columns",
  category: "connections",
  keywords: "fivetran, schema config, columns, hashed columns, blocked columns, pii, primary key, column hashing",
  docLlm:
    "One row per column present in a connection's schema config (GET /v1/connections/{id}/schemas, " +
    "flattened): connection_id, schema_name, table_name, column_name, name_in_destination, enabled " +
    "(false = blocked), hashed (column hashing for PII), is_primary_key, table_enabled and the patch " +
    "settings. Fivetran includes columns only for tables whose columns have been configured or fetched; " +
    `use it to audit PII hashing and blocking. ${FANOUT_NOTE}`,
  docMd:
    "## connection_columns\n\nColumns in each connection's schema config with blocking, hashing and primary-key flags.",
  pushdown: "`connection_id` (= / IN) selects which connections are read (path parameter).",
  paged: false,
  notFoundEmpty: true,
  foreignKeys: { connection_id: "connections" },
  columns: [
    connectionIdCol(),
    C.str("schema_name", "Source schema name.", "schema_name", false),
    C.str("table_name", "Source table name.", "table_name", false),
    C.str("column_name", "Source column name.", "column_name", false),
    C.str("name_in_destination", "Column name in the destination.", "name_in_destination"),
    C.bool("enabled", "Whether the column syncs (false = blocked).", "enabled"),
    C.bool("hashed", "Whether values are hashed before loading.", "hashed"),
    C.bool("is_primary_key", "Whether the column is part of the primary key.", "is_primary_key"),
    C.bool("table_enabled", "Whether the column's table syncs.", "table_enabled"),
    C.str("target_data_type", "Destination type override, if set.", "target_data_type"),
    ...patchCols(),
  ],
  primaryKey: ["connection_id", "schema_name", "table_name", "column_name"],
  rows: flattenSchemaConfig("column"),
  fanout: CONNECTION_FANOUT((id) => ({ path: `/v1/connections/${enc(id)}/schemas` })),
  examples: [
    {
      sql: `SELECT connection_id, table_name, column_name FROM ${Q}.connection_columns WHERE hashed ORDER BY ALL`,
      description: "Columns hashed for PII",
    },
    {
      sql: `SELECT connection_id, count(*) FILTER (WHERE NOT enabled) AS blocked, count(*) FILTER (WHERE hashed) AS hashed FROM ${Q}.connection_columns GROUP BY connection_id ORDER BY connection_id`,
      description: "Blocked and hashed column counts per connection",
    },
  ],
});

const connectionState = defineFivetranTable({
  name: "connection_states",
  description: "The saved sync state (cursor) of each connection",
  title: "Fivetran Connection State",
  category: "connections",
  keywords: "fivetran, connection state, cursor, checkpoint, connector sdk state",
  docLlm:
    "The opaque sync state Fivetran keeps per connection (GET /v1/connections/{id}/state) as JSON — " +
    "cursors, LSNs, bookmarks (e.g. for Connector SDK and function connections). connection_id plus " +
    `state. ${FANOUT_NOTE}`,
  docMd: "## connection_states\n\nThe saved state (cursor / checkpoint) of each connection as JSON.",
  pushdown: "`connection_id` (= / IN) selects which connections are read (path parameter).",
  paged: false,
  notFoundEmpty: true,
  foreignKeys: { connection_id: "connections" },
  columns: [connectionIdCol(), C.json("state", "The connection's state object as JSON (NULL when none).", "state")],
  primaryKey: ["connection_id"],
  fanout: CONNECTION_FANOUT((id) => ({ path: `/v1/connections/${enc(id)}/state` })),
  examples: [
    {
      sql: `SELECT connection_id, state->>'lsn' AS lsn FROM ${Q}.connection_states WHERE connection_id = 'c_postgres'`,
      description: "Read one field of a connection's state",
    },
  ],
});

const connectionErrors = defineFivetranTable({
  name: "connection_errors",
  description: "Current errors of each connection",
  title: "Fivetran Connection Errors",
  category: "connections",
  keywords: "fivetran, connection errors, failures, broken connections, alerts",
  docLlm:
    "Errors currently raised on connections (GET /v1/connections/{id}/errors): connection_id, type, title, " +
    `reason, message (what to do) and created_at. ${FANOUT_NOTE}`,
  docMd: "## connection_errors\n\nOpen errors per connection with the reason and suggested action.",
  pushdown: "`connection_id` (= / IN) selects which connections are read (path parameter).",
  notFoundEmpty: true,
  foreignKeys: { connection_id: "connections" },
  columns: [
    connectionIdCol(),
    C.str("type", "Error type.", "type"),
    C.str("title", "Short title.", "title"),
    C.str("reason", "Why it failed.", "reason"),
    C.str("message", "What to do about it.", "message"),
    C.time("created_at", "When the error was raised.", "created_at"),
  ],
  fanout: CONNECTION_FANOUT((id) => ({ path: `/v1/connections/${enc(id)}/errors` })),
  examples: [
    {
      sql: `SELECT c.schema_name, e.title, e.created_at FROM ${Q}.connection_errors e JOIN ${Q}.connections c ON c.id = e.connection_id ORDER BY e.created_at DESC`,
      description: "All open connection errors, newest first",
    },
  ],
});

const connectionWarnings = defineFivetranTable({
  name: "connection_warnings",
  description: "Current per-table warnings of each connection",
  title: "Fivetran Connection Warnings",
  category: "connections",
  keywords: "fivetran, connection warnings, table warnings, schema drift, alerts",
  docLlm:
    "Warnings on a connection's tables (GET /v1/connections/{id}/warnings, flattened): connection_id, " +
    `schema_name, table_name, code, message, error_message and created_at. ${FANOUT_NOTE}`,
  docMd: "## connection_warnings\n\nWarnings per connection table.",
  pushdown: "`connection_id` (= / IN) selects which connections are read (path parameter).",
  paged: false,
  notFoundEmpty: true,
  foreignKeys: { connection_id: "connections" },
  columns: [
    connectionIdCol(),
    C.str("schema_name", "Source schema.", "schema"),
    C.str("table_name", "Source table.", "table"),
    C.str("code", "Warning code.", "code"),
    C.str("message", "Warning message.", "message"),
    C.str("error_message", "Underlying error detail.", "error_message"),
    C.time("created_at", "When the warning was raised.", "created_at"),
  ],
  rows: (data) => {
    const items = (data as { items?: Row[] } | null)?.items ?? [];
    return items.flatMap((t) =>
      (Array.isArray(t.warnings) ? (t.warnings as Row[]) : []).map((w) => ({ schema: t.schema, table: t.table, ...w })),
    );
  },
  fanout: CONNECTION_FANOUT((id) => ({ path: `/v1/connections/${enc(id)}/warnings` })),
  examples: [
    {
      sql: `SELECT code, count(*) AS tables FROM ${Q}.connection_warnings GROUP BY code ORDER BY tables DESC`,
      description: "Warning codes by number of affected tables",
    },
  ],
});

// ----------------------------------------------------------------- sync history

/** Fivetran keeps 7 days of sync history in the REST API; windows are at most 7 days. */
export const HISTORY_DAYS = 7;
const WINDOW_SLACK_MS = 5 * 60_000;

/**
 * The [start_time, end_time] window for a sync-history request: the pushed `started_at`
 * bounds clamped to what Fivetran accepts (start no more than 7 days ago, range ≤ 7 days).
 * Null when the pushed bounds leave nothing to ask for.
 */
export function syncWindow(constraints: Constraint[], anchorMs: number): { start: string; end: string } | null {
  const minStart = anchorMs - HISTORY_DAYS * DAY_MS + WINDOW_SLACK_MS;
  const maxEnd = anchorMs + WINDOW_SLACK_MS;
  const b = timeBounds(constraints, "started_at");
  const lo = Math.max(b.lower ?? minStart, minStart);
  const hi = Math.min(b.upper ?? maxEnd, maxEnd);
  if (lo >= hi) return null;
  return { start: new Date(lo).toISOString(), end: new Date(hi).toISOString() };
}

const durationSeconds = (r: Row): number | null => {
  const s = typeof r.start === "string" ? Date.parse(r.start) : Number.NaN;
  const e = typeof r.end === "string" ? Date.parse(r.end) : Number.NaN;
  return Number.isNaN(s) || Number.isNaN(e) ? null : (e - s) / 1000;
};

const syncHistory = defineFivetranTable({
  name: "syncs",
  description: "Sync runs of each connection over the last 7 days",
  title: "Fivetran Sync History",
  category: "syncs",
  keywords: "fivetran, sync history, syncs, runs, sync status, failures, volume, extract, load, duration",
  docLlm:
    "Individual syncs (GET /v1/connections/{id}/sync-history): connection_id, id (the sync id), status " +
    "(COMPLETED, FAILURE, CANCELED, INCOMPLETE, RESCHEDULED, PAUSED), reason (why it did not complete), " +
    "started_at, ended_at (NULL while running), duration_seconds and the extract / process / load " +
    "volumes. The REST API keeps only the last 7 days: a pushed started_at range becomes the " +
    "start_time / end_time window (clamped to those 7 days; without one the full 7 days is read). " +
    `${FANOUT_NOTE} Older history lives in the Fivetran Platform Connector, not the REST API.`,
  docMd: "## syncs\n\nSync runs per connection (last 7 days) with outcome, timing and data volume.",
  pushdown:
    "`connection_id` (= / IN) selects connections (path parameter); `started_at` ranges → `start_time` / `end_time` (clamped to the API's 7-day window).",
  notFoundEmpty: true,
  foreignKeys: { connection_id: "connections" },
  columns: [
    connectionIdCol(),
    C.str("id", "Fivetran's unique identifier of this sync run (sync_id).", "sync_id", false),
    C.str("status", "COMPLETED, FAILURE, CANCELED, INCOMPLETE, RESCHEDULED or PAUSED.", "status"),
    C.str("reason", "Failure / cancellation reason (NULL when completed).", "reason"),
    C.time("started_at", "When the sync started.", "start"),
    C.time("ended_at", "When the sync finished (NULL while running).", "end"),
    C.num("duration_seconds", "ended_at − started_at in seconds.", durationSeconds),
    C.num(
      "extract_volume",
      "Data volume extracted from the source in this sync (Fivetran's stage volume, rows/records as reported by the API).",
      "stages.extract.volume",
    ),
    C.num(
      "process_volume",
      "Data volume processed in this sync (Fivetran's stage volume, rows/records as reported by the API).",
      "stages.process.volume",
    ),
    C.num(
      "load_volume",
      "Data volume loaded into the destination in this sync (Fivetran's stage volume, rows/records as reported by the API).",
      "stages.load.volume",
    ),
  ],
  primaryKey: ["connection_id", "id"],
  fanout: {
    key: "connection_id",
    parents: ALL_CONNECTIONS,
    parentId: idOf,
    child: (id, scan) => {
      const w = syncWindow(scan.constraints, scan.anchorMs);
      if (!w) return null;
      return {
        path: `/v1/connections/${enc(id)}/sync-history`,
        query: { start_time: w.start, end_time: w.end },
        ctx: { connection_id: id },
      };
    },
  },
  examples: [
    {
      sql: `SELECT connection_id, count(*) FILTER (WHERE status = 'FAILURE') AS failures, count(*) AS syncs, avg(duration_seconds) AS avg_seconds FROM ${Q}.syncs GROUP BY connection_id ORDER BY failures DESC`,
      description: "Failure counts and mean sync duration per connection (last 7 days)",
    },
    {
      sql: `SELECT id, status, reason, started_at FROM ${Q}.syncs WHERE connection_id = 'c_postgres' AND started_at >= TIMESTAMPTZ '2026-11-14 00:00:00+00' ORDER BY started_at DESC`,
      description: "Recent syncs of one connection (connection and time window push down)",
    },
  ],
});

/** Map a Fivetran sync status onto the unified orchestrator status set. */
export function unifiedStatus(raw: string | null, start: unknown, end: unknown): string {
  if (start == null) return "queued";
  if (end == null) return "running";
  switch (raw) {
    case "COMPLETED":
      return "success";
    case "CANCELED":
    case "PAUSED":
      return "cancelled";
    case "RESCHEDULED":
      return "skipped";
    default:
      return "failed"; // FAILURE, INCOMPLETE (ended without completing) and anything new
  }
}

const runs = defineFivetranTable({
  name: "runs",
  schemaName: "unified",
  description: "Fivetran syncs in the cross-orchestrator unified.runs shape",
  title: "Fivetran Unified Runs",
  category: "unified",
  keywords: "fivetran, unified runs, orchestrator, pipeline runs, syncs, union, airflow, dagster, prefect",
  docLlm:
    "Fivetran syncs (last 7 days, from GET /v1/connections/{id}/sync-history) with exactly the columns " +
    "every orchestrator worker exposes in unified.runs, so they UNION ALL with Airflow, Dagster, Prefect, " +
    "Temporal, Databricks, dbt and GitHub runs: orchestrator = 'fivetran', run_id = sync_id, pipeline = " +
    "the connection's schema name, status (success / failed / cancelled / skipped / running / queued, " +
    "mapped from raw_status COMPLETED / FAILURE+INCOMPLETE / CANCELED+PAUSED / RESCHEDULED), trigger NULL " +
    "(the API does not say), queued_at NULL, started_at, ended_at, duration_seconds and url (the " +
    "connection's dashboard page). WHERE pipeline = / IN narrows the connection listing (schema " +
    "parameter) and started_at ranges become the API's time window.",
  docMd: "## unified.runs\n\nFivetran syncs in the shared `unified.runs` shape for cross-orchestrator UNIONs.",
  pushdown:
    "`pipeline` (= / IN) → `schema` on the connection listing; `started_at` ranges → `start_time` / `end_time` (clamped to 7 days).",
  columns: [
    C.str("orchestrator", "Always 'fivetran'.", () => "fivetran", false),
    C.str("run_id", "The Fivetran sync id.", "sync_id", false),
    C.str("pipeline", "The connection's schema name (its name in the dashboard).", (r) => r.__ctx?.pipeline ?? null),
    C.str(
      "status",
      "queued, running, success, failed, cancelled or skipped.",
      (r) => unifiedStatus(asStr(r.status), r.start, r.end),
      false,
    ),
    C.str("raw_status", "Fivetran's status: COMPLETED, FAILURE, CANCELED, INCOMPLETE, RESCHEDULED, PAUSED.", "status"),
    C.str("trigger", "How the run was triggered (NULL: Fivetran's sync history does not record it).", () => null),
    C.time("queued_at", "When the run was queued (NULL: not recorded by Fivetran).", () => null),
    C.time("started_at", "When the sync started.", "start"),
    C.time("ended_at", "When the sync finished (NULL while running).", "end"),
    C.num("duration_seconds", "ended_at − started_at in seconds.", durationSeconds),
    C.str("url", "The connection's status page in the Fivetran dashboard.", (r) =>
      r.__ctx?.connection_id ? dashboardUrl(r.__ctx.connection_id) : null,
    ),
  ],
  primaryKey: ["run_id"],
  notFoundEmpty: true,
  fanout: {
    parents: ({ constraints }) => {
      const names = eqValues(constraints, "pipeline");
      return names ? names.map((n) => ({ path: "/v1/connections", query: { schema: n } })) : ALL_CONNECTIONS();
    },
    parentId: (r) => (typeof r.id === "string" ? `${r.id}\t${asStr(r.schema) ?? ""}` : null),
    child: (entry, scan) => {
      const [id = "", pipeline = ""] = entry.split("\t");
      const w = syncWindow(scan.constraints, scan.anchorMs);
      if (!w || !id) return null;
      return {
        path: `/v1/connections/${enc(id)}/sync-history`,
        query: { start_time: w.start, end_time: w.end },
        ctx: { connection_id: id, pipeline },
      };
    },
  },
  examples: [
    {
      sql: "SELECT pipeline, status, count(*) AS runs FROM fivetran.unified.runs GROUP BY ALL ORDER BY pipeline, status",
      description: "Run outcomes per Fivetran connection in the unified shape",
    },
    {
      sql: "SELECT orchestrator, pipeline, run_id, started_at FROM fivetran.unified.runs WHERE status = 'failed' AND started_at >= TIMESTAMPTZ '2026-11-14 00:00:00+00' ORDER BY started_at DESC",
      description: "Failed syncs since a date (UNION ALL with other orchestrators' unified.runs)",
    },
  ],
});

// --------------------------------------------------------------------- webhooks

const webhooks = defineFivetranTable({
  name: "webhooks",
  description: "Webhooks that receive Fivetran events (secrets omitted)",
  title: "Fivetran Webhooks",
  category: "infrastructure",
  keywords: "fivetran, webhooks, notifications, events, sync_end, alerts",
  docLlm:
    "Every webhook (GET /v1/webhooks): id, type (account or group), group_id, url, events (`LIST`), active, " +
    "created_at, created_by and has_secret — the signing secret itself is never returned. Join group_id to " +
    "groups.id for group webhooks.",
  docMd:
    "## webhooks\n\nAccount and group webhooks with their target URL and subscribed events. Secrets are not exposed.",
  pushdown: "none (the endpoint has no filters); the SDK applies WHERE locally.",
  columns: [
    C.str("id", "Webhook id.", "id", false),
    C.str("type", "account or group.", "type"),
    C.str("group_id", "Group for group webhooks.", "group_id"),
    C.str("url", "Target URL.", "url"),
    C.strList("events", "Subscribed events, e.g. sync_start, sync_end.", "events"),
    C.bool("active", "Whether the webhook is delivering.", "active"),
    C.bool(
      "has_secret",
      "Whether a signing secret is configured (the secret is not exposed).",
      (r) => typeof r.secret === "string" && r.secret !== "",
    ),
    C.time("created_at", "When the webhook was created.", "created_at"),
    C.str("created_by", "Id of the user who created it.", "created_by"),
  ],
  primaryKey: ["id"],
  foreignKeys: { group_id: "groups" },
  requests: () => [{ path: "/v1/webhooks" }],
  examples: [
    {
      sql: `SELECT id, url FROM ${Q}.webhooks WHERE active AND list_contains(events, 'sync_end') ORDER BY id`,
      description: "Active webhooks notified when syncs end",
    },
  ],
});

// ---------------------------------------------------------------- infrastructure

const hybridAgents = defineFivetranTable({
  name: "hybrid_deployment_agents",
  description: "Hybrid deployment agents that run syncs in your own environment",
  title: "Fivetran Hybrid Agents",
  category: "infrastructure",
  keywords: "fivetran, hybrid deployment, agents, on-premises, kubernetes, docker, local processing",
  docLlm:
    "Every hybrid deployment agent (GET /v1/hybrid-deployment-agents): id, display_name, group_id, " +
    "version, enabled, online, deployment_type (DOCKER / PODMAN / KUBERNETES / SNOWPARK), registered_at, " +
    "updated_at, last_used_at, created_by and usage (`LIST` of the connections it runs: connection_id, " +
    "schema, service). WHERE group_id = pushes down as the groupId parameter. Join group_id to groups.id.",
  docMd: "## hybrid_deployment_agents\n\nHybrid deployment agents with version, health and the connections they run.",
  pushdown: "`group_id` (= / IN) → `groupId`.",
  columns: [
    C.str("id", "Agent id.", "id", false),
    C.str("display_name", "Agent name.", "display_name"),
    C.str("group_id", "Group the agent serves.", "group_id"),
    C.str("version", "Agent version.", "version"),
    C.bool("enabled", "Whether the agent is enabled.", "enabled"),
    C.bool("online", "Whether the agent is currently connected.", "online"),
    C.str("deployment_type", "DOCKER, PODMAN, KUBERNETES or SNOWPARK.", "deployment_type"),
    C.time("registered_at", "When the agent registered.", "registered_at"),
    C.time("updated_at", "Last update.", "updated_at"),
    C.time("last_used_at", "Last time a sync used it.", "last_used_at"),
    C.str("created_by", "Id of the creating user.", "created_by"),
    C.structList(
      "usage",
      "Connections the agent runs, as {connection_id, schema, service}.",
      [
        { name: "connection_id", path: "connection_id" },
        { name: "schema", path: "schema" },
        { name: "service", path: "service" },
      ],
      "usage",
    ),
  ],
  primaryKey: ["id"],
  foreignKeys: { group_id: "groups" },
  requests: ({ constraints }) => {
    const gs = eqValues(constraints, "group_id");
    return gs
      ? gs.map((g) => ({ path: "/v1/hybrid-deployment-agents", query: { groupId: g } }))
      : [{ path: "/v1/hybrid-deployment-agents" }];
  },
  examples: [
    {
      sql: `SELECT display_name, version, online, len(usage) AS connections FROM ${Q}.hybrid_deployment_agents WHERE group_id = 'g_lake' ORDER BY display_name`,
      description: "Agents of one group with health and load (group_id pushes down)",
    },
  ],
});

const privateLinks = defineFivetranTable({
  name: "private_links",
  description: "Private links (AWS PrivateLink, Azure Private Link, GCP PSC)",
  title: "Fivetran Private Links",
  category: "infrastructure",
  keywords: "fivetran, private link, privatelink, psc, networking, vpc",
  docLlm:
    "Every private link (GET /v1/private-links): id, name, service, region, cloud_provider, state (OK / " +
    "CREATING / UPDATING / DESTROYING / FAIL) as link_state, state_summary, host, created_at and created_by.",
  docMd: "## private_links\n\nPrivate networking links with their cloud, region and state.",
  pushdown: "none (the endpoint has no filters); the SDK applies WHERE locally.",
  columns: [
    C.str("id", "Private link id.", "id", false),
    C.str("name", "Display name given to the private link.", "name"),
    C.str("service", "Link service, e.g. SNOWFLAKE_AWS, SOURCE_GCP.", "service"),
    C.str("region", "Cloud region the link terminates in, e.g. GCP_US_EAST4.", "region"),
    C.str("cloud_provider", "AWS, GCP or AZURE.", "cloud_provider"),
    C.str("link_state", "Provisioning state: OK, CREATING, UPDATING, DESTROYING or FAIL.", "state"),
    C.str("state_summary", "Detail when the state is not OK.", "state_summary"),
    C.str("host", "Endpoint host.", "host"),
    C.time("created_at", "When it was created.", "created_at"),
    C.str("created_by", "Id of the creating user.", "created_by"),
  ],
  primaryKey: ["id"],
  requests: () => [{ path: "/v1/private-links" }],
  examples: [
    {
      sql: `SELECT name, cloud_provider, link_state FROM ${Q}.private_links ORDER BY name`,
      description: "Private links and their state",
    },
  ],
});

const proxyAgents = defineFivetranTable({
  name: "proxy_agents",
  description: "Proxy agents that tunnel Fivetran traffic into private networks",
  title: "Fivetran Proxy Agents",
  category: "infrastructure",
  keywords: "fivetran, proxy agent, networking, tunnel",
  docLlm:
    "Every proxy agent (GET /v1/proxy): id, display_name, region, version, status (CONNECTED / " +
    "NOT_CONNECTED / NOT_FOUND), connector_count, destination_count, registered_at, created_by.",
  docMd: "## proxy_agents\n\nProxy agents with status and how many connections and destinations use them.",
  pushdown: "none (the endpoint has no filters); the SDK applies WHERE locally.",
  columns: [
    C.str("id", "Proxy agent id.", "id", false),
    C.str("display_name", "Name.", "display_name"),
    C.str("region", "Fivetran region the agent connects to, e.g. AWS_US_EAST_1.", "region"),
    C.str("version", "Agent version.", "version"),
    C.str("status", "CONNECTED, NOT_CONNECTED or NOT_FOUND.", "status"),
    C.int("connector_count", "Count of connections routed through the agent.", "connector_count"),
    C.int("destination_count", "Count of destinations routed through the agent.", "destination_count"),
    C.time("registered_at", "When it registered.", "registered_at"),
    C.str("created_by", "Id of the creating user.", "created_by"),
  ],
  primaryKey: ["id"],
  requests: () => [{ path: "/v1/proxy" }],
  examples: [
    {
      sql: `SELECT display_name, status, connector_count FROM ${Q}.proxy_agents ORDER BY display_name`,
      description: "Proxy agent health",
    },
  ],
});

const logServices = defineFivetranTable({
  name: "log_services",
  description: "External log services Fivetran streams its logs to",
  title: "Fivetran Log Services",
  category: "infrastructure",
  keywords: "fivetran, external logging, log service, datadog, cloudwatch, splunk, logs",
  docLlm:
    "Every external logging destination (GET /v1/external-logging): id, service (datadog, cloudwatch, " +
    "splunk, …), enabled and setup_state. Fivetran's sync logs themselves are not readable through the " +
    "REST API; they are delivered to these services or to the Fivetran Platform Connector.",
  docMd: "## log_services\n\nWhere Fivetran ships its logs (the log events themselves are not in the REST API).",
  pushdown: "none (the endpoint has no filters); the SDK applies WHERE locally.",
  columns: [
    C.str("id", "Log service id.", "id", false),
    C.str("service", "Log service type, e.g. datadog.", "service"),
    C.bool("enabled", "Whether logs are being sent.", "enabled"),
    C.str("setup_state", "Setup state, e.g. connected.", "status.setup_state"),
  ],
  primaryKey: ["id"],
  requests: () => [{ path: "/v1/external-logging" }],
  examples: [
    {
      sql: `SELECT service, enabled FROM ${Q}.log_services ORDER BY service`,
      description: "Configured log destinations",
    },
  ],
});

// --------------------------------------------------------------- transformations

const transformations = defineFivetranTable({
  name: "transformations",
  description: "Transformations (dbt Core and Quickstart) with their last run",
  title: "Fivetran Transformations",
  category: "transformations",
  keywords: "fivetran, transformations, dbt, dbt core, quickstart, models, schedule, last run",
  docLlm:
    "Every transformation (GET /v1/transformations): id, type (DBT_CORE or QUICKSTART), status of the " +
    "latest run (SUCCEEDED, FAILED, RUNNING, …), paused, last_started_at, last_ended_at, " +
    "output_model_names, the schedule (schedule_type `'INTEGRATED'` / `'TIME_OF_DAY'` / `'INTERVAL'` / `'CRON'`, " +
    "time_of_day, interval_minutes, cron, days_of_week, connection_ids, smart_syncing), project_id and " +
    "transformation_config as JSON. Only the latest run is exposed: the REST API has no transformation " +
    "run history. WHERE type = and project_id = push down as query parameters.",
  docMd: "## transformations\n\nTransformations with type, schedule and the status of their latest run.",
  pushdown: "`type =` → `type`; `project_id =` → `project_id`.",
  columns: [
    C.str("id", "Transformation id.", "id", false),
    C.str("type", "DBT_CORE or QUICKSTART.", "type"),
    C.str("status", "Latest run: NEW, SCHEDULING, RUNNING, SUCCEEDED, FAILED, PARTIALLY_SUCCEEDED, …", "status"),
    C.bool("paused", "Whether the schedule is paused.", "paused"),
    C.time("last_started_at", "Latest run start.", "last_started_at"),
    C.time("last_ended_at", "Latest run end.", "last_ended_at"),
    C.strList("output_model_names", "Models the transformation builds.", "output_model_names"),
    C.str("project_id", "dbt project id (DBT_CORE).", "transformation_config.project_id"),
    C.str(
      "schedule_type",
      "Schedule kind: 'INTEGRATED' (after connection syncs), 'TIME_OF_DAY', 'INTERVAL' or 'CRON'.",
      "schedule.schedule_type",
    ),
    C.str("time_of_day", "Time of day for TIME_OF_DAY schedules.", "schedule.time_of_day"),
    C.int("interval_minutes", "Interval between runs, in minutes (interval schedules only).", "schedule.interval"),
    C.strList("cron", "Cron expressions for CRON schedules.", "schedule.cron"),
    C.strList("days_of_week", "Days the schedule runs.", "schedule.days_of_week"),
    C.strList("connection_ids", "Connections that trigger an INTEGRATED schedule.", "schedule.connection_ids"),
    C.bool("smart_syncing", "Whether runs wait for upstream syncs.", "schedule.smart_syncing"),
    C.time("created_at", "When it was created.", "created_at"),
    C.str("created_by_id", "Id of the creating user.", "created_by_id"),
    C.json(
      "transformation_config",
      "Type-specific configuration (dbt steps or Quickstart package).",
      "transformation_config",
    ),
  ],
  primaryKey: ["id"],
  requests: ({ constraints }) => [
    {
      path: "/v1/transformations",
      query: { type: oneValue(constraints, "type"), project_id: oneValue(constraints, "project_id") },
    },
  ],
  examples: [
    {
      sql: `SELECT id, type, status, last_ended_at - last_started_at AS last_runtime FROM ${Q}.transformations WHERE NOT paused ORDER BY last_started_at DESC`,
      description: "Active transformations with their latest outcome and runtime",
    },
    {
      sql: `SELECT id, unnest(output_model_names) AS model FROM ${Q}.transformations WHERE type = 'DBT_CORE' ORDER BY ALL`,
      description: "Models built by dbt Core transformations (type pushes down)",
    },
  ],
});

const transformationProjects = defineFivetranTable({
  name: "transformation_projects",
  description: "dbt projects connected to Fivetran Transformations",
  title: "Fivetran Transformation Projects",
  category: "transformations",
  keywords: "fivetran, dbt project, transformation project, git",
  docLlm:
    "Every transformation project (GET /v1/transformation-projects): id, type (DBT_CORE), group_id, created_at, created_by_id. Join group_id to groups.id, and id to transformations.project_id.",
  docMd: "## transformation_projects\n\ndbt projects registered for Fivetran Transformations.",
  pushdown: "none (the endpoint has no filters); the SDK applies WHERE locally.",
  columns: [
    C.str("id", "Project id.", "id", false),
    C.str("type", "Project type (DBT_CORE).", "type"),
    C.str("group_id", "Group whose destination the project builds in.", "group_id"),
    C.time("created_at", "When it was created.", "created_at"),
    C.str("created_by_id", "Id of the creating user.", "created_by_id"),
  ],
  primaryKey: ["id"],
  foreignKeys: { group_id: "groups" },
  requests: () => [{ path: "/v1/transformation-projects" }],
  examples: [
    {
      sql: `SELECT p.id, count(t.id) AS transformations FROM ${Q}.transformation_projects p LEFT JOIN ${Q}.transformations t ON t.project_id = p.id GROUP BY p.id ORDER BY p.id`,
      description: "Transformations per dbt project",
    },
  ],
});

// --------------------------------------------------------------- access control

const roles = defineFivetranTable({
  name: "roles",
  description: "Roles available in the account (built-in and custom)",
  title: "Fivetran Roles",
  category: "account",
  keywords: "fivetran, roles, rbac, permissions, custom roles",
  docLlm:
    "Every role (GET /v1/roles): name, description, scope (`LIST` of ACCOUNT / DESTINATION / CONNECTOR / " +
    "TEAM), is_custom, is_deprecated and replacement_role_name.",
  docMd: "## roles\n\nBuilt-in and custom roles with the scopes they apply to.",
  pushdown: "none (the endpoint has no filters); the SDK applies WHERE locally.",
  columns: [
    C.str("name", "Role name.", "name", false),
    C.str("description", "What the role allows.", "description"),
    C.strList("scope", "Where the role applies: ACCOUNT, DESTINATION, CONNECTOR, TEAM.", "scope"),
    C.bool("is_custom", "Whether it is a custom role.", "is_custom"),
    C.bool("is_deprecated", "Whether it is deprecated.", "is_deprecated"),
    C.str("replacement_role_name", "Role replacing a deprecated one.", "replacement_role_name"),
  ],
  primaryKey: ["name"],
  requests: () => [{ path: "/v1/roles" }],
  examples: [
    {
      sql: `SELECT name FROM ${Q}.roles WHERE list_contains(scope, 'DESTINATION') AND NOT is_deprecated ORDER BY name`,
      description: "Current destination-level roles",
    },
  ],
});

const systemKeys = defineFivetranTable({
  name: "system_keys",
  description: "System keys (service API keys) and their permissions; key material omitted",
  title: "Fivetran System Keys",
  category: "account",
  keywords: "fivetran, system keys, api keys, service credentials, permissions, expiry, access review",
  docLlm:
    "Every system key (GET /v1/system-keys) without its key or secret: id, name, permissions (`LIST` of " +
    "{resource_type, access_level, ids, group_ids}), created_at, updated_at, expired_at, last_used_at. " +
    "Use it to find unused, expiring or over-privileged keys.",
  docMd: "## system_keys\n\nSystem keys with their permissions and usage; key material is not exposed.",
  pushdown: "none (the endpoint has no filters); the SDK applies WHERE locally.",
  columns: [
    C.str("id", "System key id.", "id", false),
    C.str("name", "Display name given to the system key.", "name"),
    C.structList(
      "permissions",
      "Grants as {resource_type, access_level, ids, group_ids}; ids / group_ids are JSON arrays.",
      [
        { name: "resource_type", path: "resource_type" },
        { name: "access_level", path: "access_level" },
        { name: "ids", path: "resource_filter.ids" },
        { name: "group_ids", path: "resource_filter.group_ids" },
      ],
      "permissions",
    ),
    C.time("created_at", "When it was created.", "created_at"),
    C.time("updated_at", "Last change.", "updated_at"),
    C.time("expired_at", "When it expires.", "expired_at"),
    C.time("last_used_at", "Last use.", "last_used_at"),
  ],
  primaryKey: ["id"],
  requests: () => [{ path: "/v1/system-keys" }],
  examples: [
    {
      sql: `SELECT name, p.resource_type, p.access_level FROM ${Q}.system_keys, unnest(permissions) AS u(p) WHERE p.access_level = 'MANAGE' ORDER BY name`,
      description: "System keys with manage permissions",
    },
  ],
});

// --------------------------------------------------------------- connector types

const connectorTypes = defineFivetranTable({
  name: "connector_types",
  description: "The catalogue of Fivetran source connector types",
  title: "Fivetran Connector Types",
  category: "connections",
  keywords: "fivetran, connector types, sources, catalogue, services, metadata, supported features",
  docLlm:
    "Every source type Fivetran offers (GET /v1/metadata/connector-types): id (the service name used in " +
    "connections.service), name, type (category such as Database, Marketing, Finance), description, " +
    "connector_class (standard / lite), service_status (general_availability, beta, …), " +
    "supported_features (`LIST`, e.g. COLUMN_HASHING, HISTORY), supports_schema_reload, link_to_docs and " +
    "icon_url. Join connections.service = connector_types.id for readable names.",
  docMd: "## connector_types\n\nFivetran's connector catalogue with category, maturity and supported features.",
  pushdown: "none (the endpoint has no filters); the SDK applies WHERE locally.",
  columns: [
    C.str("id", "Service id (matches connections.service).", "id", false),
    C.str("name", "Display name.", "name"),
    C.str("type", "Category, e.g. Database, Marketing, Finance, File.", "type"),
    C.str("description", "Short summary of what the source is.", "description"),
    C.str("connector_class", "standard or lite.", "connector_class"),
    C.str("service_status", "general_availability, beta, private_preview, sunset, development.", "service_status"),
    C.strList("supported_features", "Feature ids, e.g. COLUMN_HASHING, HISTORY, CAPTURE_DELETES.", (r) =>
      Array.isArray(r.supported_features) ? r.supported_features.map((f: Row) => f?.id).filter(Boolean) : null,
    ),
    C.bool("supports_schema_reload", "Whether the schema can be reloaded.", "supports_schema_reload"),
    C.str("link_to_docs", "Setup documentation URL.", "link_to_docs"),
    C.str("icon_url", "URL of the connector's logo image.", "icon_url"),
  ],
  primaryKey: ["id"],
  requests: () => [{ path: "/v1/metadata/connector-types" }],
  examples: [
    {
      sql: `SELECT ct.name, count(*) AS connections FROM ${Q}.connections c JOIN ${Q}.connector_types ct ON ct.id = c.service GROUP BY ct.name ORDER BY connections DESC`,
      description: "Connections per source type, with readable names",
    },
  ],
});

/** Tables in schema `main`. */
export const MAIN_TABLES: TableDescriptor[] = [
  account,
  users,
  teams,
  teamUsers,
  teamGroups,
  teamConnections,
  userGroups,
  userConnections,
  groups,
  groupUsers,
  destinations,
  connections,
  connectionSchemas,
  connectionTables,
  connectionColumns,
  connectionState,
  connectionErrors,
  connectionWarnings,
  syncHistory,
  transformations,
  transformationProjects,
  webhooks,
  hybridAgents,
  privateLinks,
  proxyAgents,
  logServices,
  roles,
  systemKeys,
  connectorTypes,
];

/** Tables in schema `unified`. */
export const UNIFIED_TABLES: TableDescriptor[] = [runs];
