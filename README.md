<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

<p align="center"><em>A Query.Farm VGI worker for DuckDB.</em></p>

# Query Fivetran Connections, Sync History and Schema Config in DuckDB

> **vgi-fivetran** · a [Query.Farm](https://query.farm) VGI worker · written in TypeScript

[![CI](https://github.com/Query-farm/vgi-fivetran/actions/workflows/ci.yml/badge.svg)](https://github.com/Query-farm/vgi-fivetran/actions/workflows/ci.yml)
[![vgi worker: query.farm](https://query.farm/media-kit/shields/vgi-worker.svg)](https://query.farm)

Fivetran's ELT control plane as SQL, read-only, through the
[Fivetran REST API v1](https://fivetran.com/docs/rest-api/api-reference): which
connections are broken, paused or late, what every sync did over the last week, which
tables and columns are blocked or hashed, and who can touch what.

```sql
CREATE SECRET fivetran (TYPE fivetran, API_KEY '…', API_SECRET '…');

-- Active connections that are broken or whose last sync failed.
SELECT schema_name, service, setup_state, failed_at
FROM fivetran.main.connections
WHERE NOT paused
  AND (setup_state <> 'connected' OR failed_at > coalesce(succeeded_at, TIMESTAMPTZ '1970-01-01'));

-- Sync failures per connection over the last 7 days (one call per connection).
SELECT connection_id, count(*) FILTER (WHERE status = 'FAILURE') AS failures, avg(duration_seconds)
FROM fivetran.main.syncs GROUP BY ALL ORDER BY failures DESC;

-- PII audit: hashed and blocked columns of one connection (connection_id pushes down).
SELECT table_name, column_name, hashed, NOT enabled AS blocked
FROM fivetran.main.connection_columns
WHERE connection_id = 'my_connection_id' AND (hashed OR NOT enabled);
```

## Tables

Everything is a catalog table in `fivetran.main`, plus `fivetran.unified.runs`. Filters
push down where the REST API has a matching path or query parameter, and the SDK re-applies
every predicate exactly, so pushdown only ever narrows the request.

Per-parent tables (per connection, team, user or group) read only the parents named by a
pushed `WHERE <parent>_id = … / IN (…)`; without one they list every parent first and make
one more call per parent.

| Table | Fivetran endpoint | What pushes down |
|---|---|---|
| `accounts` | `GET /v1/account/info` | — (one row) |
| `users` | `GET /v1/users` | `active = true` → `active`; `user_type =`; `has_api_key = true/false` |
| `teams` | `GET /v1/teams` | — |
| `team_users`, `team_groups`, `team_connections` | `GET /v1/teams/{id}/users\|groups\|connections` | `team_id` |
| `user_groups`, `user_connections` | `GET /v1/users/{id}/groups\|connections` | `user_id` |
| `groups` | `GET /v1/groups` | — |
| `group_users` | `GET /v1/groups/{id}/users` | `group_id`; `active = true` |
| `destinations` | `GET /v1/destinations` | — (credentials are not exposed) |
| `connections` | `GET /v1/connections`, `GET /v1/connections/{id}` | `id` (`=`/`IN`, fetched directly); `group_id` (`=`/`IN`); `schema_name =` → `schema` |
| `connection_schemas`, `connection_tables`, `connection_columns` | `GET /v1/connections/{id}/schemas` (flattened) | `connection_id` |
| `connection_states` | `GET /v1/connections/{id}/state` | `connection_id` |
| `connection_errors` | `GET /v1/connections/{id}/errors` | `connection_id` |
| `connection_warnings` | `GET /v1/connections/{id}/warnings` (flattened) | `connection_id` |
| `syncs` | `GET /v1/connections/{id}/sync-history` | `connection_id`; `started_at` ranges → `start_time`/`end_time` |
| `transformations` | `GET /v1/transformations` | `type =`; `project_id =` |
| `transformation_projects` | `GET /v1/transformation-projects` | — |
| `webhooks` | `GET /v1/webhooks` | — (the signing secret is never returned; `has_secret` instead) |
| `hybrid_deployment_agents` | `GET /v1/hybrid-deployment-agents` | `group_id` (`=`/`IN`) → `groupId` |
| `private_links`, `proxy_agents`, `log_services` | `GET /v1/private-links`, `/v1/proxy`, `/v1/external-logging` | — |
| `roles` | `GET /v1/roles` | — |
| `system_keys` | `GET /v1/system-keys` | — (key and secret omitted) |
| `connector_types` | `GET /v1/metadata/connector-types` | — |
| `unified.runs` | `GET /v1/connections/{id}/sync-history` | `pipeline` (`=`/`IN`) → `schema` on the connection listing; `started_at` ranges |

Columns are typed: `TIMESTAMP WITH TIME ZONE` for every `*_at` (microseconds kept),
`BOOLEAN`, `INTEGER`, `DOUBLE`, `VARCHAR[]` and `STRUCT(…)[]` (connection `tasks` /
`warnings`, agent `usage`, key `permissions`). Only genuinely open shapes are `JSON`:
connection `config`, connection `state` and `transformation_config`. In connection
`config`, every value whose key looks like a credential (password, secret, token, key,
private, credential, certificate…) is replaced with `******`, even when Fivetran returned
it unmasked. Ids are attested `PRIMARY KEY`s and the per-parent and reference columns are
declared `FOREIGN KEY`s, so `duckdb_constraints()` and agents can see the joins.

### Sync history and `unified.runs`

`GET /v1/connections/{id}/sync-history` returns discrete syncs (`sync_id`, `start`, `end`,
`status`, `reason`, extract / process / load volumes), so the worker exposes
`unified.runs` in the column shape every orchestrator worker shares:

| Column | Fivetran value |
|---|---|
| `orchestrator` | `'fivetran'` |
| `run_id` | `sync_id` |
| `pipeline` | the connection's schema name (its name in the dashboard) |
| `status` / `raw_status` | `COMPLETED` → success; `FAILURE`, `INCOMPLETE` → failed; `CANCELED`, `PAUSED` → cancelled; `RESCHEDULED` → skipped; no `end` → running; no `start` → queued |
| `trigger`, `queued_at` | `NULL`: sync history does not record them |
| `started_at`, `ended_at`, `duration_seconds` | `start`, `end`, their difference |
| `url` | `https://fivetran.com/dashboard/connections/<id>/status` |

The API keeps **7 days** of history and accepts windows of at most 7 days that start no
more than 7 days ago. A pushed `started_at` range is clamped to that window; without one the
whole week is read; a range entirely older than that sends no request. There is no
`unified.task_runs`: a sync's stages have volumes but no timings or statuses. The worker
assumes the API returns syncs whose `start` lies in the window (a wider answer is still
filtered exactly).

### What the REST API does not expose

- **Monthly active rows (MAR), usage and cost**: no REST endpoint on any plan. They are
  in the Fivetran dashboard and in the
  [Fivetran Platform Connector](https://fivetran.com/docs/logs/fivetran-platform)
  (`INCREMENTAL_MAR`, usage tables), which you can query in your warehouse.
- **Log events / connector events**: not readable over REST. `log_services` lists where
  they are streamed (external logging); the Platform Connector's `LOG` table holds them.
- **Sync history older than 7 days** and **transformation run history**: only each
  transformation's latest run (`status`, `last_started_at`, `last_ended_at`) is exposed.

## Authentication

Create one `fivetran` secret with an API key and its secret: a user's key (*Account
Settings → API Key*) or a [system key](https://fivetran.com/docs/rest-api/getting-started).
Both are sent as HTTP Basic auth and see what that user or key's permissions allow.

```sql
CREATE SECRET fivetran (TYPE fivetran, API_KEY '…', API_SECRET '…');
-- optional: BASE_URL 'https://api.fivetran.com' (https only, except http://127.0.0.1 / localhost
--           for local test servers; a trailing /v1 is accepted), PAGE_SIZE 1000 (1..1000)
```

`API_KEY` and `API_SECRET` are redacted secret fields. Credentials are read from the secret
on every call and never stored in scan state, so they never travel in HTTP continuation
tokens.

## Paging and rate limits

Each Fivetran page becomes one Arrow batch. The cursor (`next_cursor`, the scan phase and,
during a fan-out, the pending parent ids) lives in the scan's serializable state, so long
scans resume on any worker process over the HTTP transport. HTTP 429 waits for
`Retry-After` (seconds or an HTTP date, up to 60 s); 5xx and network errors retry with
exponential backoff; every request has a 30 s timeout.

## Install

**Prerequisites:** [Bun](https://bun.sh) 1.3+ (for a source checkout).

```bash
git clone https://github.com/Query-farm/vgi-fivetran.git && cd vgi-fivetran
bun install --frozen-lockfile
```

**DuckDB 2.0:**

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;
ATTACH 'fivetran' (TYPE vgi, LOCATION '/abs/path/to/vgi-fivetran/bin/vgi-fivetran-worker');
```

**Haybarn 2.0** (`uvx haybarn-cli`):

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'fivetran' (TYPE vgi, LOCATION '/abs/path/to/vgi-fivetran/bin/vgi-fivetran-worker');
```

`LOCATION` is the command DuckDB runs, so use an absolute path. Tagged releases ship signed
standalone executables (no Bun needed) for Linux, macOS (arm64) and Windows; point
`LOCATION` at the downloaded binary. The same binary serves HTTP with `--http --port 8000`
(see the `Dockerfile`).

## Testing

```bash
make test-unit                 # bun unit tests (window clamping, masking, status mapping, paging, backoff)
make test-sql                  # test/sql/fivetran.test through Haybarn 2.0 (stdio)
make test-sql TRANSPORT=http   # …over HTTP (also: launch)
make check                     # everything CI runs
```

No test touches the network or a real Fivetran account. `test/mock_api/server.py` is a
stdlib-only replay server over a hand-built account (`test/fixtures/fivetran-account.json`,
shaped after Fivetran's documented responses). It enforces Basic auth and the JSON `Accept`
header, rejects unknown query parameters, bad `limit`s and bad cursors, pages with
`cursor`/`next_cursor`, applies the documented sync-history window rules, and answers the
first request to every path with a 429 + `Retry-After` so the retry path always runs. The
SQL tests read its `/__requests` log to check exactly what was pushed down.

The metadata check runs with `execute: false` in CI: every table needs a `fivetran` secret
for a live account.

## Authorship & License

Written by [Query.Farm](https://query.farm). Released under the
[BSD Zero Clause License](LICENSE) (0BSD).

Copyright 2026 Query Farm LLC - https://query.farm
