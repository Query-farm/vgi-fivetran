#!/usr/bin/env python3
"""An offline Fivetran REST API v1 replay server for the tests (stdlib only).

It serves the hand-built account in ``test/fixtures/fivetran-account.json`` (documented
Fivetran response shapes, https://fivetran.com/docs/rest-api/api-reference) and behaves
like Fivetran where the worker depends on it:

* **Auth.** HTTP Basic ``test-key:test-secret`` (an API key + secret, or a system key).
  Anything else is a 401 ``{"code": "AuthFailed", ...}``.
* **Envelope.** ``{"code": "Success", "data": {...}}``; lists are
  ``data.items`` + ``data.next_cursor``.
* **Query validation.** Each route accepts only its documented query parameters; an
  unknown one, a ``limit`` outside 1..1000, a bad ``cursor`` or a bad boolean is a 400
  ``InvalidInput``. An unknown id is a 404 ``NotFound_<Thing>``.
* **Paging.** ``limit`` (default 100) + opaque ``cursor`` (``next_cursor``).
* **Sync history.** ``start_time`` / ``end_time`` (ISO 8601); omitted bounds default to
  one hour around the other one (or the last hour), a window over 7 days, a start after
  the end, or a start more than 7 days ago is a 400 — exactly the documented rules.
  Records whose ``start`` falls in the window are returned, newest first. Fixture times
  are offsets before server start so they never age out.
* **Rate limits.** The first request to every path answers 429 with ``Retry-After``
  (``1`` the first time the server does it, ``0`` afterwards so the suite stays fast),
  so the retry path always runs.
* **Introspection.** ``GET /__requests?path=/v1/users`` returns every recorded request to
  that path (``seq``, ``path``, ``query`` as a JSON object string, ``status``,
  ``accept``), so SQL tests can assert exactly what was pushed down.

Usage::

    python3 test/mock_api/server.py            # prints PORT:<n> once listening
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
ACCOUNT = json.loads((HERE.parent / "fixtures" / "fivetran-account.json").read_text())
AUTH = "Basic " + base64.b64encode(b"test-key:test-secret").decode()
START = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
WEEK = dt.timedelta(days=7)

LOCK = threading.Lock()
REQUESTS: list[dict] = []
THROTTLED: set[str] = set()


def iso(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


SYNCS: dict[str, list[dict]] = {}
for _cid, _rows in ACCOUNT["sync_history"].items():
    out = []
    for r in _rows:
        r = dict(r)
        s, e = r.pop("start_offset_minutes"), r.pop("end_offset_minutes")
        r["start"] = iso(START - dt.timedelta(minutes=s)) if s is not None else None
        r["end"] = iso(START - dt.timedelta(minutes=e)) if e is not None else None
        out.append(r)
    SYNCS[_cid] = sorted(out, key=lambda x: x["start"] or "", reverse=True)


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, headers: dict | None = None):
        super().__init__(message)
        self.status, self.code, self.message, self.headers = status, code, message, headers or {}


def bad(msg: str) -> ApiError:
    return ApiError(400, "InvalidInput", msg)


def parse_time(v: str, name: str) -> dt.datetime:
    try:
        t = dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        raise bad(f"{name} must be an ISO 8601 timestamp, got {v!r}") from None
    if t.tzinfo is None:
        raise bad(f"{name} must carry a time zone")
    return t


def page(items: list, q: dict) -> dict:
    limit = 100
    if "limit" in q:
        if not re.fullmatch(r"\d+", q["limit"]) or not 1 <= int(q["limit"]) <= 1000:
            raise bad("limit must be an integer in the range 1..1000")
        limit = int(q["limit"])
    off = 0
    if "cursor" in q:
        try:
            off = int(base64.urlsafe_b64decode(q["cursor"].encode()).decode().removeprefix("off:"))
        except Exception:
            raise bad("Invalid cursor") from None
    chunk = items[off : off + limit]
    data: dict = {"items": chunk}
    if off + limit < len(items):
        data["next_cursor"] = base64.urlsafe_b64encode(f"off:{off + limit}".encode()).decode()
    return data


def boolean(q: dict, name: str) -> bool | None:
    if name not in q:
        return None
    if q[name] not in ("true", "false"):
        raise bad(f"{name} must be true or false")
    return q[name] == "true"


def find(rows: list[dict], key: str, value: str, what: str) -> dict:
    for r in rows:
        if r.get(key) == value:
            return r
    raise ApiError(404, f"NotFound_{what}", f"{what} with id '{value}' doesn't exist")


PAGED = {"cursor", "limit"}


def users_list(q: dict, rows: list[dict]) -> dict:
    active = boolean(q, "active")
    if active is not None:
        rows = [u for u in rows if u["active"] == active]
    return page(rows, q)


def route(path: str, q: dict) -> tuple[set[str], object]:
    """Return (allowed query params, response data) for a GET."""
    A = ACCOUNT
    parts = [p for p in path.split("/") if p]
    if parts[:1] != ["v1"]:
        raise ApiError(404, "NotFound", f"no route {path}")
    p = parts[1:]
    conn_ids = [c["id"] for c in A["connections"]]

    def need_conn(cid: str) -> None:
        if cid not in conn_ids:
            raise ApiError(404, "NotFound_Connection", f"Connection with id '{cid}' doesn't exist")

    match p:
        case ["account", "info"]:
            return set(), A["account"]
        case ["users"]:
            allowed = PAGED | {"active", "user_type", "has_api_key"}
            rows = A["users"]
            if "user_type" in q:
                if q["user_type"] not in ("REGULAR_USER", "SERVICE_ACCOUNT"):
                    raise bad("user_type must be REGULAR_USER or SERVICE_ACCOUNT")
                rows = [u for u in rows if u["user_type"] == q["user_type"]]
            hk = boolean(q, "has_api_key")
            if hk is not None:
                rows = [u for u in rows if u["has_api_key"] == hk]
            return allowed, lambda: users_list(q, rows)
        case ["users", uid, ("groups" | "connections") as kind]:
            find(A["users"], "id", uid, "User")
            return PAGED, lambda: page(A[f"user_{kind}"].get(uid, []), q)
        case ["teams"]:
            return PAGED, lambda: page(A["teams"], q)
        case ["teams", tid, "users"]:
            find(A["teams"], "id", tid, "Team")
            return PAGED | {"active"}, lambda: page(A["team_users"].get(tid, []), q)
        case ["teams", tid, ("groups" | "connections") as kind]:
            find(A["teams"], "id", tid, "Team")
            return PAGED, lambda: page(A[f"team_{kind}"].get(tid, []), q)
        case ["groups"]:
            return PAGED, lambda: page(A["groups"], q)
        case ["groups", gid, "users"]:
            find(A["groups"], "id", gid, "Group")
            members = {
                uid for uid, gs in A["user_groups"].items() if any(g["id"] == gid for g in gs)
            }
            return PAGED | {"active"}, lambda: users_list(q, [u for u in A["users"] if u["id"] in members])
        case ["destinations"]:
            return PAGED, lambda: page(A["destinations"], q)
        case ["connections"]:
            rows = A["connections"]
            if "group_id" in q:
                rows = [c for c in rows if c["group_id"] == q["group_id"]]
            if "schema" in q:
                rows = [c for c in rows if c["schema"] == q["schema"]]
            return PAGED | {"group_id", "schema"}, lambda: page(rows, q)
        case ["connections", cid]:
            return set(), find(A["connections"], "id", cid, "Connection")
        case ["connections", cid, "schemas"]:
            need_conn(cid)
            return set(), A["schemas"][cid]
        case ["connections", cid, "state"]:
            need_conn(cid)
            return set(), A["state"][cid]
        case ["connections", cid, "errors"]:
            need_conn(cid)
            return PAGED, lambda: page(A["errors"][cid], q)
        case ["connections", cid, "warnings"]:
            need_conn(cid)
            return set(), {"items": A["warnings"][cid]}
        case ["connections", cid, "sync-history"]:
            need_conn(cid)
            return PAGED | {"start_time", "end_time", "duration"}, lambda: sync_history(cid, q)
        case ["webhooks"]:
            return PAGED, lambda: page(A["webhooks"], q)
        case ["hybrid-deployment-agents"]:
            rows = A["hybrid_deployment_agents"]
            if "groupId" in q:
                rows = [h for h in rows if h["group_id"] == q["groupId"]]
            return PAGED | {"groupId"}, lambda: page(rows, q)
        case ["transformations"]:
            rows = A["transformations"]
            if "type" in q:
                if q["type"] not in ("DBT_CORE", "QUICKSTART"):
                    raise bad("type must be DBT_CORE or QUICKSTART")
                rows = [t for t in rows if t["type"] == q["type"]]
            if "project_id" in q:
                rows = [t for t in rows if (t.get("transformation_config") or {}).get("project_id") == q["project_id"]]
            if "group_id" in q:
                raise bad("group_id filtering is not supported by this replay fixture")
            return PAGED | {"group_id", "project_id", "type"}, lambda: page(rows, q)
        case ["transformation-projects"]:
            return PAGED, lambda: page(A["transformation_projects"], q)
        case ["roles"]:
            return PAGED, lambda: page(A["roles"], q)
        case ["system-keys"]:
            return PAGED, lambda: page(A["system_keys"], q)
        case ["metadata", "connector-types"]:
            return PAGED, lambda: page(A["connector_types"], q)
        case ["external-logging"]:
            return PAGED, lambda: page(A["log_services"], q)
        case ["private-links"]:
            return PAGED, lambda: page(A["private_links"], q)
        case ["proxy"]:
            return PAGED, lambda: page(A["proxy_agents"], q)
    raise ApiError(404, "NotFound", f"no route {path}")


def sync_history(cid: str, q: dict) -> dict:
    if "duration" in q:
        raise bad("duration is deprecated; use start_time and end_time")
    now = dt.datetime.now(dt.timezone.utc)
    hour = dt.timedelta(hours=1)
    start = parse_time(q["start_time"], "start_time") if "start_time" in q else None
    end = parse_time(q["end_time"], "end_time") if "end_time" in q else None
    if start is None and end is None:
        end, start = now, now - hour
    elif start is None:
        start = end - hour
    elif end is None:
        end = start + hour
    if start >= end:
        raise bad("start_time must be before end_time")
    if end - start > WEEK:
        raise bad("The maximum allowed range between start_time and end_time is 7 days")
    if start < now - WEEK:
        raise bad("start_time cannot be more than 7 days in the past")
    rows = [
        r for r in SYNCS[cid]
        if r["start"] and start <= dt.datetime.fromisoformat(r["start"].replace("Z", "+00:00")) <= end
    ]
    return page(rows, q)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet
        pass

    def send(self, status: int, body: object, headers: dict | None = None) -> None:
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):  # noqa: N802
        u = urlparse(self.path)
        raw_q = parse_qs(u.query, keep_blank_values=True)
        if u.path == "/__requests":
            want = (raw_q.get("path") or [""])[0]
            with LOCK:
                rows = [r for r in REQUESTS if not want or r["path"] == want]
            self.send(200, rows)
            return
        q = {k: v[-1] for k, v in raw_q.items()}
        rec = {"seq": 0, "path": u.path, "query": json.dumps(q, sort_keys=True), "status": 0,
               "accept": self.headers.get("Accept") or ""}
        with LOCK:
            rec["seq"] = len(REQUESTS) + 1
            REQUESTS.append(rec)
        try:
            if self.headers.get("Authorization") != AUTH:
                raise ApiError(401, "AuthFailed", "Missing or invalid API key and secret")
            if "application/json" not in rec["accept"]:
                raise ApiError(406, "NotAcceptable", "Accept must be application/json")
            if any(len(v) > 1 for v in raw_q.values()):
                raise bad("repeated query parameter")
            allowed, data = route(u.path, q)
            unknown = sorted(set(q) - allowed)
            if unknown:
                raise bad(f"Unknown query parameter(s): {', '.join(unknown)}")
            with LOCK:
                first = u.path not in THROTTLED
                if first:
                    THROTTLED.add(u.path)
                    retry = "1" if len(THROTTLED) == 1 else "0"
            if first:
                raise ApiError(429, "TooManyRequests", "Rate limit exceeded", {"Retry-After": retry})
            body = data() if callable(data) else data
            rec["status"] = 200
            self.send(200, {"code": "Success", "data": body})
        except ApiError as e:
            rec["status"] = e.status
            self.send(e.status, {"code": e.code, "message": e.message}, e.headers)

    def do_POST(self):  # noqa: N802 — the worker is read-only; a write is a test failure.
        self.send(405, {"code": "MethodNotAllowed", "message": "this replay server is read-only"})

    do_PATCH = do_DELETE = do_PUT = do_POST


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"PORT:{srv.server_address[1]}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
