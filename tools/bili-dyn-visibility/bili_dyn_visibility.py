#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""bili-dyn-visibility — detect Bilibili dynamics that are "self-visible" (仅自己可见).

A dynamic is *self-visible* when it still appears in the logged-in account's own
dynamic feed but cannot be seen by other accounts or by logged-out (anonymous)
visitors.  This tool enumerates every dynamic of the account inside a lookback
window (default 96h), probes each one anonymously, and reports the problems.

Standalone: Python 3 standard library only, no kyestu / idol-bbq imports.
Credentials are read from a cookie file and are never written to stdout, logs,
reports or the state file — only the cookie file path and a redacted
fingerprint ("SESSDATA len=…") may be logged.

Usage: see README.md.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

VERSION = "1.0.0"

EXIT_CLEAN = 0
EXIT_FINDINGS = 1
EXIT_ERROR = 2

VERDICT_OK = "ok"
VERDICT_SELF_VISIBLE = "self-visible"
VERDICT_DELETED = "deleted"
VERDICT_UNKNOWN = "unknown"
FINDINGS_VERDICTS = (VERDICT_SELF_VISIBLE, VERDICT_DELETED, VERDICT_UNKNOWN)

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

NAV_URL = "https://api.bilibili.com/x/web-interface/nav"
FEED_URL = "https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space"
DETAIL_URL = "https://api.bilibili.com/x/polymer/web-dynamic/v1/detail"
PERMALINK_FMT = "https://t.bilibili.com/%s"

# "definitive absence" signatures for the polymer dynamic detail endpoint.
# Observed live 2026-09-30: a bogus dyn id returns HTTP 200 with
# code=500 message="Cannot read property 'only_fans' of undefined", and a
# dynamic hidden from outsiders returns code=4101152 message="动态不可见".
ABSENT_CODES = (-404, 404, 410202, 4101152)
ABSENT_MSG_RE = re.compile(
    r"不存在|没有权限|无权限|已删除|仅自己可见|不可见|only_fans|啥都木有|not\s*found|deleted", re.I
)
RATE_LIMIT_CODES = (-412, -352, -509)
AUTH_CODES = (-101, -111)

MAX_FEED_PAGES = 50
ANON_FEED_PROBE_PAGES = 3
ANON_CIRCUIT_BREAKER = 5  # consecutive anon rate-limits before skipping further anon probes
STATE_HISTORY_LIMIT = 50

_SECRETS = set()


def register_secret(value):
    """Remember sensitive strings so they can be scrubbed from any output."""
    if value and isinstance(value, str) and len(value) >= 6:
        _SECRETS.add(value)


def redact(text):
    """Scrub every registered secret from a string before it can be stored/printed."""
    if not text:
        return text
    out = str(text)
    for secret in _SECRETS:
        if secret in out:
            out = out.replace(secret, "***REDACTED***")
    return out


# structural API identifiers are never cookie material; a coincidental
# substring collision must not mangle them
REDACT_EXEMPT_KEYS = ("dyn_id", "permalink")


def redact_tree(obj, key=None):
    """Recursively scrub secrets from a JSON-like structure (JSON-safe by construction).

    Applied before json.dumps so a redacted value can never corrupt the
    document's syntax (a bare `***REDACTED***` where a number token was).
    """
    if key in REDACT_EXEMPT_KEYS:
        return obj
    if isinstance(obj, str):
        return redact(obj)
    if isinstance(obj, dict):
        return {k: redact_tree(v, key=k) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact_tree(v) for v in obj]
    return obj


# ---------------------------------------------------------------------------
# cookie handling
# ---------------------------------------------------------------------------


class CookieError(Exception):
    pass


def _json_cookie_entries(obj):
    cookies = None
    if isinstance(obj, dict):
        info = obj.get("cookie_info")
        if isinstance(info, dict):
            cookies = info.get("cookies")
        if cookies is None and isinstance(obj.get("cookies"), list):
            cookies = obj.get("cookies")
    if not isinstance(cookies, list):
        raise CookieError("JSON cookie shape not recognized (expected cookie_info.cookies)")
    return cookies


def _pairs_from_json(text):
    try:
        obj = json.loads(text)
    except ValueError as exc:
        raise CookieError("cookie file looks like JSON but failed to parse: %s" % exc)
    pairs = []
    for entry in _json_cookie_entries(obj):
        if isinstance(entry, dict) and entry.get("name") and entry.get("value") is not None:
            pairs.append((str(entry.get("name")), str(entry.get("value"))))
    return pairs


def _netscape_pair(line):
    parts = line.split("\t")
    name = parts[5].strip()
    return [(name, parts[6].strip())] if name else []


def _inline_pairs(line):
    pairs = []
    for pair in line.split(";"):
        pair = pair.strip()
        if pair and "=" in pair:
            name, value = pair.split("=", 1)
            if name.strip():
                pairs.append((name.strip(), value.strip()))
    return pairs


def _pairs_from_line(line):
    line = line.strip()
    if not line:
        return []
    if line.startswith("#HttpOnly_"):
        line = line[len("#HttpOnly_") :]
    elif line.startswith("#"):
        return []
    if "\t" in line and len(line.split("\t")) >= 7:
        return _netscape_pair(line)
    return _inline_pairs(line)


def parse_cookie_text(text):
    """Parse any of the three supported cookie shapes into a {name: value} jar.

    1. biliup-style JSON:  {"cookie_info": {"cookies": [{"name":..., "value":...}, ...]}}
    2. Netscape cookies.txt lines (tab separated, `#HttpOnly_` prefix tolerated)
    3. raw `SESSDATA=...; bili_jct=...` string(s)
    """
    if text is None:
        raise CookieError("cookie content is empty")
    text = text.strip()
    if not text:
        raise CookieError("cookie content is empty")
    if text.startswith("{"):
        pairs = _pairs_from_json(text)
    else:
        pairs = []
        for line in text.splitlines():
            pairs.extend(_pairs_from_line(line))
    jar = {}
    for name, value in pairs:
        jar[name] = value
    if not jar:
        raise CookieError("no name=value cookie pairs found")
    if "SESSDATA" not in jar:
        raise CookieError("SESSDATA missing from cookie material")
    for value in jar.values():
        register_secret(value)
    return jar


def load_cookie(source):
    """Load a cookie jar from a file path (or a raw cookie string). Returns (jar, meta)."""
    if source and os.path.isfile(source):
        try:
            with open(source, "r", encoding="utf-8") as fh:
                text = fh.read()
        except OSError as exc:
            raise CookieError("cannot read cookie file %s: %s" % (source, exc))
        origin = source
    else:
        text = source or ""
        origin = "<inline>"
    jar = parse_cookie_text(text)
    meta = {
        "source": origin,
        "fingerprint": "SESSDATA len=%d" % len(jar.get("SESSDATA", "")),
    }
    return jar, meta


def cookie_header(jar):
    return "; ".join("%s=%s" % (k, v) for k, v in jar.items())


# ---------------------------------------------------------------------------
# HTTP layer (injectable fetch)
# ---------------------------------------------------------------------------


class FetchResult(object):
    __slots__ = ("status", "body", "headers")

    def __init__(self, status, body, headers=None):
        self.status = status
        self.body = body if isinstance(body, bytes) else str(body).encode("utf-8")
        self.headers = headers or {}


def default_fetch(url, headers, timeout=20):
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return FetchResult(resp.status, resp.read(), dict(resp.headers))
    except urllib.error.HTTPError as exc:
        body = b""
        try:
            body = exc.read()
        except Exception:  # pragma: no cover - defensive
            pass
        return FetchResult(exc.code, body, dict(getattr(exc, "headers", {}) or {}))


def build_headers(cookie=None):
    headers = {
        "User-Agent": DEFAULT_UA,
        "Referer": "https://t.bilibili.com/",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9",
    }
    if cookie:
        headers["Cookie"] = cookie
    return headers


_UNSET = object()  # distinguishes "use client default cookie" from "no cookie at all"


class ApiResult(object):
    """One API call result. Never holds cookie material."""

    def __init__(self, endpoint, http_status=None, api_code=None, api_message=None,
                 data=None, error_kind=None, attempts=1, error_detail=None):
        self.endpoint = endpoint
        self.http_status = http_status
        self.api_code = api_code
        self.api_message = api_message
        self.data = data
        self.error_kind = error_kind  # None | rate-limit | server | http | auth | network
        self.attempts = attempts
        self.error_detail = error_detail

    @property
    def ok(self):
        return self.error_kind is None and self.api_code == 0

    def evidence(self, probe):
        ev = {
            "probe": probe,
            "endpoint": self.endpoint,
            "http_status": self.http_status,
            "api_code": self.api_code,
            "api_message": redact(self.api_message),
            "attempts": self.attempts,
        }
        if self.error_kind:
            ev["error_kind"] = self.error_kind
        if self.error_detail:
            ev["error_detail"] = redact(self.error_detail)
        return ev


def _parse_json_body(body):
    body_text = body.decode("utf-8", "replace")
    if not body_text.lstrip().startswith("{"):
        return {}
    try:
        parsed = json.loads(body_text)
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _classify_response(status, api_code):
    """Return (error_kind, retryable) for one HTTP + API-code response."""
    if status == 412 or status == 429:
        return "rate-limit", True
    if status >= 500:
        return "server", True
    if api_code in RATE_LIMIT_CODES:
        return "rate-limit", True
    if api_code in AUTH_CODES:
        return "auth", False
    if status >= 400:
        return "http", False
    return None, False


class BiliAPI(object):
    """Rate-limited, retrying JSON GET client with an injectable transport."""

    def __init__(self, fetch=None, cookie=None, min_interval=1.0, max_retries=3,
                 backoff_base=2.0, timeout=20, sleep=None, time_fn=None, log=None):
        self.fetch = fetch or default_fetch
        self.cookie = cookie
        self.min_interval = float(min_interval)
        self.max_retries = int(max_retries)
        self.backoff_base = float(backoff_base)
        self.timeout = timeout
        self.sleep = sleep or time.sleep
        self.time_fn = time_fn or time.monotonic
        self.log = log or (lambda msg: None)
        self._last_call = 0.0

    def _throttle(self):
        now = self.time_fn()
        wait = self.min_interval - (now - self._last_call)
        if wait > 0:
            self.sleep(wait)
        self._last_call = self.time_fn()

    def _attempt(self, url, cookie):
        """One transport attempt. Returns (result, retryable)."""
        self._throttle()
        try:
            fr = self.fetch(url, build_headers(cookie), self.timeout)
        except Exception as exc:  # transport failure
            detail = "%s: %s" % (type(exc).__name__, exc)
            return ApiResult(url, None, None, None, None, "network", 0, detail), True
        parsed = _parse_json_body(fr.body)
        api_code = parsed.get("code")
        api_message = parsed.get("message")
        if api_message is not None:
            api_message = str(api_message)
        error_kind, retryable = _classify_response(fr.status, api_code)
        return ApiResult(url, fr.status, api_code, api_message, parsed,
                         error_kind, 0), retryable

    def get(self, url, cookie=_UNSET, probe=""):
        """GET a JSON endpoint. Retries rate-limits / 5xx / network errors with backoff.

        cookie=_UNSET uses the client default; cookie=None means strictly anonymous.
        """
        if cookie is _UNSET:
            cookie = self.cookie
        attempts = 0
        while True:
            attempts += 1
            result, retryable = self._attempt(url, cookie)
            result.attempts = attempts
            if not retryable or attempts > self.max_retries:
                return result
            delay = min(self.backoff_base * (2 ** (attempts - 1)), 60.0)
            self.log("retrying %s in %.1fs (attempt %d, %s)" %
                     (probe or url, delay, attempts, result.error_kind))
            self.sleep(delay)


# ---------------------------------------------------------------------------
# dynamic item helpers
# ---------------------------------------------------------------------------


def item_dyn_id(item):
    value = item.get("id_str") or item.get("id")
    return str(value) if value is not None else None


def item_type(item):
    return item.get("type") or "UNKNOWN"


def item_pub_ts(item):
    modules = item.get("modules") or {}
    author = modules.get("module_author") or {}
    ts = author.get("pub_ts")
    if isinstance(ts, bool):
        return None
    if isinstance(ts, (int, float)):
        return int(ts)
    # live API returns pub_ts as a decimal string ("1790752609")
    if isinstance(ts, str) and ts.strip().isdigit():
        return int(ts.strip())
    return None


def _opus_text(opus):
    if not isinstance(opus, dict):
        return None
    summary = opus.get("summary") or {}
    if isinstance(summary, dict) and summary.get("text"):
        return str(summary.get("text"))
    return None


def _block_text(block):
    if not isinstance(block, dict):
        return None
    for sub in ("title", "desc", "text"):
        if block.get(sub):
            return str(block.get(sub))
    return None


def _major_texts(major):
    texts = []
    if not isinstance(major, dict):
        return texts
    opus_text = _opus_text(major.get("opus"))
    if opus_text:
        texts.append(opus_text)
    for key in ("draw", "article", "archive", "none"):
        block_text = _block_text(major.get(key))
        if block_text:
            texts.append(block_text)
    return texts


def _dynamic_texts(dynamic):
    texts = []
    desc = (dynamic or {}).get("desc") or {}
    if isinstance(desc, dict) and desc.get("text"):
        texts.append(str(desc.get("text")))
    texts.extend(_major_texts((dynamic or {}).get("major")))
    return texts


def item_text(item, limit=80):
    modules = item.get("modules") or {}
    dynamic = modules.get("module_dynamic") or {}
    texts = _dynamic_texts(dynamic)
    if not texts:
        orig = item.get("orig")
        if isinstance(orig, dict):
            return item_text(orig, limit=limit)
    joined = " ".join(t.strip() for t in texts if t and t.strip())
    joined = re.sub(r"\s+", " ", joined).strip()
    return joined[:limit]


def item_visible_flag(item):
    """The `visible` field of the self-feed item (semantics not fully verified).

    Evidence-only: it is recorded in the report but never decides a verdict.
    """
    return item.get("visible")


def iso_utc(ts):
    if ts is None:
        return None
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_duration(text):
    """Parse '96h', '4d', '30m', '90s', '1d12h', or a bare number (hours)."""
    text = str(text).strip().lower()
    if not text:
        raise ValueError("empty duration")
    if text.isdigit():
        return float(text) * 3600.0
    pattern = re.compile(r"(\d+(?:\.\d+)?)([smhd])")
    pos = 0
    total = 0.0
    factor = {"s": 1.0, "m": 60.0, "h": 3600.0, "d": 86400.0}
    for match in pattern.finditer(text):
        if match.start() != pos:
            raise ValueError("cannot parse duration: %r" % text)
        pos = match.end()
        total += float(match.group(1)) * factor[match.group(2)]
    if pos != len(text) or total <= 0:
        raise ValueError("cannot parse duration: %r" % text)
    return total


def normalize_type(value):
    value = str(value).strip().upper()
    if not value:
        return value
    if not value.startswith("DYNAMIC_TYPE_"):
        value = "DYNAMIC_TYPE_" + value
    return value


# ---------------------------------------------------------------------------
# probes and verdicts
# ---------------------------------------------------------------------------

OUTCOME_VISIBLE = "visible"
OUTCOME_ABSENT = "absent"
OUTCOME_ERROR = "error"
OUTCOME_SKIPPED = "skipped"


def _detail_item_present(data):
    return isinstance(data, dict) and bool(data.get("item") or data.get("id_str"))


def classify_detail(result):
    """Map a detail-endpoint result onto visible / absent / error.

    An API error is NEVER mapped onto `visible` (i.e. never onto `ok`).
    """
    if result.error_kind:
        return OUTCOME_ERROR
    if result.api_code == 0:
        data = result.data.get("data") if isinstance(result.data, dict) else None
        if _detail_item_present(data):
            return OUTCOME_VISIBLE
        return OUTCOME_ABSENT  # API answered OK but has no such dynamic
    if result.api_code in ABSENT_CODES or ABSENT_MSG_RE.search(result.api_message or ""):
        return OUTCOME_ABSENT
    return OUTCOME_ERROR


class VerdictEngine(object):
    def __init__(self, api, probe_cookie=None, verbose_log=None):
        self.api = api
        self.probe_cookie = probe_cookie  # probe account (header string), the outsider oracle
        self.log = verbose_log or (lambda msg: None)
        self.anon_streak = 0
        self.anon_circuit_open = False
        # with a probe account configured, that account IS the visibility oracle:
        # no anonymous request is ever made (anon probing is what triggers -352/-412)
        self.probe_only = bool(probe_cookie)
        self.listing_label = "probe-account-space-feed" if self.probe_only else "anon-space-feed"
        if self.probe_only:
            self.log("probe-only mode: probe account is the visibility oracle, anonymous probing disabled")

    def probe_detail(self, dyn_id, cookie, probe_name):
        url = "%s?id=%s&timezone_offset=-480" % (
            DETAIL_URL,
            urllib.parse.quote(str(dyn_id)),
        )
        result = self.api.get(url, cookie=cookie, probe=probe_name)
        outcome = classify_detail(result)
        return outcome, result.evidence(probe_name)

    def probe_anon(self, dyn_id):
        if self.probe_only:
            return OUTCOME_SKIPPED, {
                "probe": "anon-detail",
                "endpoint": DETAIL_URL,
                "http_status": None,
                "api_code": None,
                "api_message": "anonymous probing disabled (probe account is the oracle)",
                "error_kind": None,
            }
        if self.anon_circuit_open:
            return OUTCOME_ERROR, {
                "probe": "anon-detail",
                "endpoint": DETAIL_URL,
                "http_status": None,
                "api_code": None,
                "api_message": "anon probe circuit open after repeated rate-limits",
                "error_kind": "rate-limit",
            }
        outcome, evidence = self.probe_detail(dyn_id, None, "anon-detail")
        if outcome == OUTCOME_ERROR and evidence.get("error_kind") == "rate-limit":
            self.anon_streak += 1
            if self.anon_streak >= ANON_CIRCUIT_BREAKER:
                self.anon_circuit_open = True
                self.log("anon probe circuit opened after %d consecutive rate-limits"
                         % self.anon_streak)
        else:
            self.anon_streak = 0
        return outcome, evidence

    def probe_second_opinion(self, dyn_id):
        if not self.probe_cookie:
            return None, []
        outcome, evidence = self.probe_detail(
            dyn_id, self.probe_cookie, "probe-account-detail"
        )
        return outcome, [evidence]

    def decide(self, dyn_id, self_presence, anon_outcome, probe_outcome):
        """Return (verdict, decision_note).

        self_presence: True (seen in self view) / False (confirmed absent) / None (unknown)
        """
        if anon_outcome == OUTCOME_VISIBLE:
            return VERDICT_OK, "anonymous detail probe sees the dynamic"
        if anon_outcome == OUTCOME_ABSENT:
            if self_presence is False:
                return VERDICT_DELETED, "absent for both self and anonymous"
            return VERDICT_SELF_VISIBLE, "present in self view, absent for anonymous"
        # anonymous probe inconclusive / disabled: the probe account decides
        if probe_outcome == OUTCOME_VISIBLE:
            return VERDICT_OK, "probe account sees the dynamic"
        if probe_outcome == OUTCOME_ABSENT:
            if self_presence is False:
                return VERDICT_DELETED, "absent for self and for probe account"
            return VERDICT_SELF_VISIBLE, "absent for probe account (second opinion)"
        if self_presence is False and probe_outcome == OUTCOME_VISIBLE:
            return VERDICT_UNKNOWN, "absent in self view but visible to probe account"
        return VERDICT_UNKNOWN, "anonymous probe inconclusive (rate-limit / auth / network)"


# ---------------------------------------------------------------------------
# feed enumeration
# ---------------------------------------------------------------------------


def feed_url(mid, offset=""):
    return "%s?host_mid=%s&offset=%s&timezone_offset=-480&platform=web" % (
        FEED_URL,
        urllib.parse.quote(str(mid)),
        urllib.parse.quote(str(offset or "")),
    )


def _page_max_ts(batch):
    stamps = [item_pub_ts(item) for item in batch]
    stamps = [ts for ts in stamps if ts is not None]
    return max(stamps) if stamps else None


def _absorb_feed_page(items, batch, from_ts, to_ts, type_filter, notes):
    """Merge one self-feed page into items (window-filtered). Returns page max pub_ts."""
    for item in batch:
        dyn_id = item_dyn_id(item)
        if not dyn_id:
            continue
        if type_filter and normalize_type(item_type(item)) not in type_filter:
            continue
        ts = item_pub_ts(item)
        if ts is None:
            items.setdefault(dyn_id, item)
            notes.append("dynamic %s has no pub_ts; included without time check" % dyn_id)
            continue
        if from_ts <= ts <= to_ts:
            items.setdefault(dyn_id, item)
    return _page_max_ts(batch)


def _feed_stop_decision(data, max_ts, from_ts, seen_offsets, pages, max_pages):
    """Decide pagination control flow.

    Returns (stop, page_complete, note, next_offset).
    """
    if max_ts is not None and max_ts < from_ts:
        return True, True, None, ""  # window boundary crossed
    if not data.get("has_more"):
        return True, True, None, ""
    next_offset = data.get("offset") or ""
    if not next_offset or next_offset in seen_offsets:
        return True, False, "self-feed pagination stalled at page %d (offset=%r)" % (
            pages, next_offset), ""
    if pages >= max_pages:
        return True, False, "self-feed pagination hit page cap (%d)" % max_pages, next_offset
    return False, True, None, next_offset


def collect_window_items(api, mid, from_ts, to_ts, type_filter, cookie,
                         max_pages=MAX_FEED_PAGES, log=None):
    """Paginate the self feed until the window boundary is crossed.

    Returns (items, complete, notes) where items maps dyn_id -> record.
    """
    log = log or (lambda msg: None)
    items = {}
    notes = []
    complete = True
    offset = ""
    seen_offsets = set()
    pages = 0
    while True:
        pages += 1
        result = api.get(feed_url(mid, offset), cookie=cookie, probe="self-feed")
        if result.error_kind or result.api_code != 0:
            complete = False
            notes.append("self-feed page %d failed: %s" % (pages, json.dumps(
                result.evidence("self-feed"), ensure_ascii=False)))
            break
        data = (result.data or {}).get("data") or {}
        batch = data.get("items") or []
        max_ts = _absorb_feed_page(items, batch, from_ts, to_ts, type_filter, notes)
        log("self-feed page %d: %d items, max_pub_ts=%s, has_more=%s" %
            (pages, len(batch), max_ts, data.get("has_more")))
        stop, page_complete, note, next_offset = _feed_stop_decision(
            data, max_ts, from_ts, seen_offsets, pages, max_pages)
        if note:
            complete = page_complete
            notes.append(note)
        if stop:
            break
        seen_offsets.add(next_offset)
        offset = next_offset
    return items, complete, notes


def _ids_from_items(ids, items):
    for item in items or []:
        dyn_id = item_dyn_id(item)
        if dyn_id:
            ids.add(dyn_id)


def _absorb_anon_page(ids, result):
    """Merge one anonymous feed page. Returns (done, next_offset)."""
    if result.error_kind or result.api_code != 0:
        return True, ""
    data = (result.data or {}).get("data") or {}
    _ids_from_items(ids, data.get("items"))
    if not data.get("has_more"):
        return True, ""
    return False, data.get("offset") or ""


def anon_feed_visible_ids(api, mid, max_pages=ANON_FEED_PROBE_PAGES, cookie=None, label="anon-space-feed"):
    """Secondary oracle: anonymous space feed listing. Best-effort.

    Returns (id_set, evidence_list). Live testing (2026-09-30) showed this
    endpoint is risk-banned for anonymous callers (-412); failures are recorded
    as evidence and the detail probe remains the primary oracle.
    """
    ids = set()
    evidence = []
    offset = ""
    for _page in range(1, max_pages + 1):
        result = api.get(feed_url(mid, offset), cookie=cookie, probe=label)
        evidence.append(result.evidence(label))
        done, offset = _absorb_anon_page(ids, result)
        if done or not offset:
            break
    return ids, evidence


# ---------------------------------------------------------------------------
# state file
# ---------------------------------------------------------------------------


def load_state(path):
    if not path or not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_state(path, state):
    if not path:
        return
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=1, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def update_state_entry(entry, dyn_id, posted_ts, now_iso, verdict, dyn_type=None, text=None):
    entry = entry or {}
    entry.setdefault("dyn_id", dyn_id)
    entry.setdefault("first_seen", now_iso)
    if posted_ts is not None:
        entry["posted_ts"] = int(posted_ts)
        entry["posted_at"] = iso_utc(posted_ts)
    entry.setdefault("posted_at", None)
    if dyn_type:
        entry["type"] = dyn_type
    if text is not None:
        entry["text"] = text[:120]
    entry["last_verdict"] = verdict
    history = entry.setdefault("verdict_history", [])
    history.append({"ts": now_iso, "verdict": verdict})
    if len(history) > STATE_HISTORY_LIMIT:
        del history[:-STATE_HISTORY_LIMIT]
    return entry


def first_detected_at(entry, verdict, now_iso):
    for record in (entry or {}).get("verdict_history") or []:
        if record.get("verdict") == verdict and record.get("ts"):
            return record.get("ts")
    return now_iso


def redact_state(state):
    """State must never carry cookie material; scrub defensively (JSON-safe)."""
    cleaned = {}
    for dyn_id, entry in state.items():
        if not isinstance(entry, dict):
            continue
        cleaned[str(dyn_id)] = redact_tree({
            "dyn_id": str(entry.get("dyn_id", dyn_id)),
            "posted_at": entry.get("posted_at"),
            "posted_ts": entry.get("posted_ts"),
            "type": entry.get("type"),
            "text": str(entry.get("text") or "")[:120],
            "first_seen": entry.get("first_seen"),
            "last_verdict": entry.get("last_verdict"),
            "verdict_history": entry.get("verdict_history") or [],
        })
    return cleaned


# ---------------------------------------------------------------------------
# reporting
# ---------------------------------------------------------------------------

TABLE_COLUMNS = (("dyn_id", 20), ("time", 16), ("type", 10), ("verdict", 12), ("snippet", 50))


def format_table(rows):
    header = "  ".join(name.ljust(width) for name, width in TABLE_COLUMNS)
    lines = [header, "-" * len(header)]
    for row in rows:
        cells = [
            str(row.get("dyn_id") or "").ljust(20),
            str(row.get("posted_at") or "-").ljust(16),
            str(row.get("type") or "").replace("DYNAMIC_TYPE_", "").ljust(10),
            str(row.get("verdict") or "").ljust(12),
            re.sub(r"\s+", " ", str(row.get("text") or ""))[:50],
        ]
        lines.append("  ".join(cells))
    return "\n".join(lines)


def _fmt_secs(seconds):
    seconds = int(max(0, seconds))
    return "%dm%02ds" % (seconds // 60, seconds % 60)


class VerdictRecorder(object):
    """Collects checked records, verdict counts, and state updates."""

    def __init__(self, state, now_iso, log=None, total=0):
        self.state = state
        self.now_iso = now_iso
        self.log = log
        self.total = total
        self.started = time.monotonic()
        self.checked = []
        self.verdict_counts = {VERDICT_OK: 0, VERDICT_SELF_VISIBLE: 0,
                               VERDICT_DELETED: 0, VERDICT_UNKNOWN: 0}
        if log:
            log("checking %d dynamics in this run (per-item progress lines follow)" % total)

    def record(self, dyn_id, posted_ts, dyn_type, text, verdict, note, evidence,
               visible_flag=None):
        entry = self.state.get(dyn_id)
        record = {
            "dyn_id": dyn_id,
            "permalink": PERMALINK_FMT % dyn_id,
            "posted_at": iso_utc(posted_ts) if posted_ts else None,
            "posted_ts": posted_ts,
            "type": dyn_type,
            "text": text,
            "verdict": verdict,
            "decision": note,
            "evidence": evidence,
        }
        if visible_flag is not None:
            record["self_visible_flag"] = visible_flag
        if verdict in FINDINGS_VERDICTS:
            record["first_detected_at"] = first_detected_at(entry, verdict, self.now_iso)
        self.checked.append(record)
        self.verdict_counts[verdict] = self.verdict_counts.get(verdict, 0) + 1
        self.state[dyn_id] = update_state_entry(entry, dyn_id, posted_ts, self.now_iso,
                                                verdict, dyn_type=dyn_type, text=text)
        if self.log:
            done = len(self.checked)
            elapsed = max(1e-6, time.monotonic() - self.started)
            rate = done / elapsed * 60.0
            remain = max(0, self.total - done)
            eta_s = (remain / rate * 60.0) if rate > 0 else 0.0
            self.log("progress %d/%d dyn=%s type=%s verdict=%s (ok=%d self-visible=%d deleted=%d unknown=%d) | %.1f/min elapsed %s ETA %s" % (
                done, self.total, dyn_id, dyn_type, verdict,
                self.verdict_counts.get(VERDICT_OK, 0),
                self.verdict_counts.get(VERDICT_SELF_VISIBLE, 0),
                self.verdict_counts.get(VERDICT_DELETED, 0),
                self.verdict_counts.get(VERDICT_UNKNOWN, 0),
                rate, _fmt_secs(elapsed), _fmt_secs(eta_s)))

    def findings(self):
        found = [rec for rec in self.checked if rec["verdict"] in FINDINGS_VERDICTS]
        found.sort(key=lambda r: (r.get("posted_ts") or 0), reverse=True)
        return found

    def checked_sorted(self):
        return sorted(self.checked, key=lambda r: (r.get("posted_ts") or 0), reverse=True)


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def build_parser():
    parser = argparse.ArgumentParser(
        prog="bili-dyn-visibility",
        description="Detect Bilibili dynamics visible only to their author (仅自己可见).",
    )
    parser.add_argument("--cookie", required=True,
                        help="cookie file (biliup JSON / Netscape / name=value) or raw cookie string")
    parser.add_argument("--mid", type=int, default=None,
                        help="account mid (auto-resolved via nav endpoint when omitted)")
    parser.add_argument("--probe-cookie", default=None,
                        help="optional second account cookie file for a second-opinion probe")
    parser.add_argument("--since", default="96h",
                        help="lookback window (e.g. 96h, 4d, 1d12h; bare number = hours)")
    parser.add_argument("--recheck-hours", type=float, default=96.0,
                        help="re-verify previously-ok dynamics posted within this many hours")
    parser.add_argument("--state", default="./bili-dyn-visibility.state.json",
                        help="state file for late-flip tracking")
    parser.add_argument("--json-out", default=None,
                        help="write the machine-readable report to this path")
    parser.add_argument("--types", default=None,
                        help="comma-separated dynamic types to scan (e.g. DRAW,WORD,AV,FORWARD)")
    parser.add_argument("--min-interval", type=float, default=1.0,
                        help="minimum seconds between API calls (default 1.0)")
    parser.add_argument("--max-retries", type=int, default=3,
                        help="bounded retries for rate-limited / 5xx responses")
    parser.add_argument("--max-pages", type=int, default=MAX_FEED_PAGES,
                        help="safety cap on self-feed pagination pages")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="progress logging to stderr (cookie values are never logged)")
    return parser


def _log_factory(verbose, err):
    def log(msg):
        if verbose:
            err.write("[%s] %s\n" % (iso_utc(time.time()), redact(msg)))
    return log


def _load_credentials(args, err, log):
    """Load main + optional probe cookies.

    Returns (cookie_header_str, cookie_meta, probe_header_or_None), or None on
    error (the error message has already been written to err).
    """
    try:
        cookie_jar, cookie_meta = load_cookie(args.cookie)
    except CookieError as exc:
        source = "cookie file" if os.path.isfile(str(args.cookie)) else "<inline>"
        err.write("error: %s (source: %s)\n" % (exc, source))
        return None
    log("cookie loaded from %s (%s)" % (cookie_meta["source"], cookie_meta["fingerprint"]))
    probe_header = None
    if args.probe_cookie:
        try:
            probe_jar, probe_meta = load_cookie(args.probe_cookie)
        except CookieError as exc:
            err.write("error: probe cookie: %s\n" % exc)
            return None
        log("probe cookie loaded from %s (%s)" % (probe_meta["source"], probe_meta["fingerprint"]))
        probe_header = cookie_header(probe_jar)
    return cookie_header(cookie_jar), cookie_meta, probe_header


def _resolve_mid(args, api, err):
    """Return (mid, nav_evidence); mid is None when resolution failed."""
    if args.mid:
        return args.mid, None
    nav = api.get(NAV_URL, probe="nav")
    nav_evidence = nav.evidence("nav")
    if not nav.ok:
        err.write("error: nav endpoint failed (%s); cannot resolve mid\n"
                  % json.dumps(nav_evidence, ensure_ascii=False))
        return None, nav_evidence
    data = (nav.data or {}).get("data") or {}
    if not data.get("isLogin"):
        err.write("error: cookie is not logged in (nav isLogin=false); "
                  "SESSDATA may be expired\n")
        return None, nav_evidence
    if not data.get("mid"):
        err.write("error: nav returned no mid\n")
        return None, nav_evidence
    return data.get("mid"), nav_evidence


def _type_filter(raw):
    if not raw:
        return None
    return set(normalize_type(t) for t in raw.split(",") if t.strip())


def _entry_posted_ts(entry):
    ts = (entry or {}).get("posted_ts")
    try:
        return int(ts) if ts is not None else None
    except (TypeError, ValueError):
        return None


def _recheck_ids(state, feed_items, recheck_cutoff):
    ids = []
    for dyn_id, entry in sorted(state.items()):
        if dyn_id in feed_items:
            continue
        posted_ts = _entry_posted_ts(entry)
        if posted_ts is None or posted_ts >= recheck_cutoff:
            ids.append(dyn_id)
    return ids


def _anon_feed_listing_evidence(label="anon-space-feed"):
    return {"probe": label, "endpoint": FEED_URL,
            "http_status": 200, "api_code": 0,
            "api_message": "dynamic listed in %s" % label}


def _check_feed_items(engine, feed_items, anon_visible, recorder):
    for dyn_id in sorted(feed_items, key=lambda d: -(item_pub_ts(feed_items[d]) or 0)):
        item = feed_items[dyn_id]
        evidence = []
        if dyn_id in anon_visible:
            anon_outcome = OUTCOME_VISIBLE
            evidence.append(_anon_feed_listing_evidence(engine.listing_label))
        else:
            anon_outcome, anon_ev = engine.probe_anon(dyn_id)
            evidence.append(anon_ev)
        probe_outcome, probe_evidence = engine.probe_second_opinion(dyn_id)
        evidence.extend(probe_evidence)
        verdict, note = engine.decide(dyn_id, True, anon_outcome, probe_outcome)
        recorder.record(dyn_id, item_pub_ts(item), item_type(item), item_text(item),
                        verdict, note, evidence, visible_flag=item_visible_flag(item))


def _check_recheck_items(engine, state, recheck_ids, self_cookie, recorder):
    for dyn_id in recheck_ids:
        entry = state.get(dyn_id) or {}
        evidence = []
        self_outcome, self_ev = engine.probe_detail(dyn_id, self_cookie, "self-detail")
        evidence.append(self_ev)
        self_presence = {OUTCOME_VISIBLE: True, OUTCOME_ABSENT: False}.get(self_outcome)
        anon_outcome, anon_ev = engine.probe_anon(dyn_id)
        evidence.append(anon_ev)
        probe_outcome, probe_evidence = engine.probe_second_opinion(dyn_id)
        evidence.extend(probe_evidence)
        verdict, note = engine.decide(dyn_id, self_presence, anon_outcome, probe_outcome)
        recorder.record(dyn_id, _entry_posted_ts(entry),
                        entry.get("type") or "UNKNOWN", entry.get("text") or "",
                        verdict, note, evidence)


def _coverage_extra_notes(engine, anon_feed_evidence):
    notes = []
    if any(ev.get("error_kind") for ev in anon_feed_evidence):
        notes.append("anonymous space-feed listing unavailable (risk control); "
                     "verdicts rest on the anonymous detail probe")
    if engine.anon_circuit_open:
        notes.append("anonymous detail probe circuit opened (repeated rate-limits)")
    return notes


def _build_report(args, mid, from_ts, to_ts, now_iso, cookie_meta,
                  coverage, coverage_notes, recorder, nav_evidence, anon_feed_evidence):
    report = {
        "tool": "bili-dyn-visibility",
        "version": VERSION,
        "generated_at": now_iso,
        # NOTE: the account mid is deliberately absent — it equals the
        # DedeUserID cookie value, and cookie values never enter any output.
        "window": {
            "since": args.since,
            "from": iso_utc(from_ts),
            "to": iso_utc(to_ts),
            "from_ts": from_ts,
            "to_ts": to_ts,
            "recheck_hours": args.recheck_hours,
        },
        "checked_count": len(recorder.checked),
        "coverage": coverage,
        "coverage_notes": coverage_notes,
        "cookie": {"source": cookie_meta["source"],
                   "fingerprint": cookie_meta["fingerprint"]},
        "verdict_counts": recorder.verdict_counts,
        "findings": recorder.findings(),
        "checked": recorder.checked_sorted(),
    }
    if nav_evidence:
        report["nav_evidence"] = nav_evidence
    if anon_feed_evidence:
        report["anon_space_feed_evidence"] = anon_feed_evidence
    return report


def _write_json_report(path, report_text, err):
    if not path:
        return True
    try:
        parent = os.path.dirname(os.path.abspath(path))
        if parent and not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(report_text + "\n")
    except OSError as exc:
        err.write("error: cannot write report %s: %s\n" % (path, exc))
        return False
    return True


def _emit_output(out, report):
    out.write(redact(format_table(report["checked"])) + "\n")
    window = report["window"]
    out.write("\nchecked=%d window=[%s .. %s] coverage=%s verdicts=%s\n" % (
        report["checked_count"], window["from"], window["to"], report["coverage"],
        " ".join("%s=%d" % (k, v) for k, v in sorted(report["verdict_counts"].items()))))
    for note in report["coverage_notes"]:
        out.write("note: %s\n" % redact(note))


def _exit_code(coverage, findings):
    if coverage != "complete":
        return EXIT_ERROR
    if findings:
        return EXIT_FINDINGS
    return EXIT_CLEAN


def run(argv=None, fetch=None, now_fn=None, sleep_fn=None, out=None, err=None):
    out = out if out is not None else sys.stdout
    err = err if err is not None else sys.stderr
    now_fn = now_fn or time.time
    args = build_parser().parse_args(argv)
    log = _log_factory(args.verbose, err)

    try:
        since_seconds = parse_duration(args.since)
    except ValueError as exc:
        err.write("error: %s\n" % exc)
        return EXIT_ERROR

    creds = _load_credentials(args, err, log)
    if creds is None:
        return EXIT_ERROR
    cookie_str, cookie_meta, probe_cookie_header = creds

    api = BiliAPI(fetch=fetch, cookie=cookie_str,
                  min_interval=args.min_interval, max_retries=args.max_retries,
                  sleep=sleep_fn, log=log)
    engine = VerdictEngine(api, probe_cookie=probe_cookie_header, verbose_log=log)

    now_ts = int(now_fn())
    from_ts = now_ts - int(since_seconds)
    to_ts = now_ts
    now_iso = iso_utc(now_ts)

    mid, nav_evidence = _resolve_mid(args, api, err)
    if mid is None:
        return EXIT_ERROR
    log("target mid=%s window=[%s .. %s]" % (mid, iso_utc(from_ts), iso_utc(to_ts)))

    feed_items, feed_complete, feed_notes = collect_window_items(
        api, mid, from_ts, to_ts, _type_filter(args.types), cookie_str,
        max_pages=args.max_pages, log=log)
    coverage = "complete" if feed_complete else "incomplete"
    coverage_notes = list(feed_notes)

    if probe_cookie_header:
        anon_visible, anon_feed_evidence = anon_feed_visible_ids(
            api, mid, max_pages=args.max_pages, cookie=probe_cookie_header,
            label="probe-account-space-feed")
    else:
        anon_visible, anon_feed_evidence = anon_feed_visible_ids(api, mid)
    coverage_notes.extend(_coverage_extra_notes(engine, anon_feed_evidence))

    state = load_state(args.state)
    recheck_cutoff = now_ts - int(float(args.recheck_hours) * 3600)
    recheck_ids = _recheck_ids(state, feed_items, recheck_cutoff)

    recorder = VerdictRecorder(state, now_iso, log=log, total=len(feed_items) + len(recheck_ids))
    _check_feed_items(engine, feed_items, anon_visible, recorder)
    _check_recheck_items(engine, state, recheck_ids, cookie_str, recorder)

    report = _build_report(args, mid, from_ts, to_ts, now_iso, cookie_meta,
                           coverage, coverage_notes, recorder,
                           nav_evidence, anon_feed_evidence)
    report_text = json.dumps(redact_tree(report), ensure_ascii=False, indent=2)
    if not _write_json_report(args.json_out, report_text, err):
        return EXIT_ERROR

    save_state(args.state, redact_state(state))
    _emit_output(out, report)
    return _exit_code(coverage, report["findings"])


def main(argv=None):
    return run(argv)


if __name__ == "__main__":
    sys.exit(main())
