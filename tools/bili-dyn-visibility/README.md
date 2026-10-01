# bili-dyn-visibility

Detect B站 dynamics (动态) that are **self-visible** (仅自己可见): the logged-in
account still sees them in its own feed, but other accounts and logged-out
visitors cannot. The tool enumerates every dynamic in a lookback window
(default 96 hours), probes each one anonymously, and reports the problems.

Standalone tool: Python 3 standard library only, no third-party packages, no
imports from kyestu or idol-bbq-utils. Detection and reporting only — it never
reposts, edits, or repairs anything.

## Quick start

```sh
python3 bili_dyn_visibility.py \
  --cookie /path/to/cookies.json \
  --json-out report.json
```

Exit codes tell the verdict:

| code | meaning |
|------|---------|
| `0`  | clean — every dynamic in the window is publicly visible |
| `1`  | findings — at least one dynamic is `self-visible`, `deleted`, or `unknown` |
| `2`  | execution/coverage error — window enumeration truncated, cookie rejected, bad arguments |

## Options

| option | default | description |
|--------|---------|-------------|
| `--cookie` | (required) | cookie file (see shapes below) or a raw `SESSDATA=...` string |
| `--mid` | auto | account mid; when omitted it is resolved through the nav endpoint |
| `--probe-cookie` | none | second account's cookie. **With it the tool runs probe-only**: that account becomes the visibility oracle (space-feed listing + detail probe) and **no anonymous request is made at all** — anonymous probing is what trips B站 -352/-412 risk control |
| `--since` | `96h` | lookback window: `96h`, `4d`, `1d12h`, or a bare number of hours |
| `--recheck-hours` | `96` | re-verify previously-`ok` dynamics posted within this many hours |
| `--state` | `./bili-dyn-visibility.state.json` | late-flip tracking state |
| `--json-out` | none | machine-readable report path |
| `--types` | all | comma-separated dynamic types, e.g. `DRAW,WORD,AV,FORWARD` |
| `--min-interval` | `1.0` | minimum seconds between API calls |
| `--max-retries` | `3` | bounded retries for rate-limited / 5xx responses |
| `-v` | off | progress logging to stderr (cookie values are never logged) |

## Verdicts

Each dynamic gets exactly one verdict. The tool never maps an API error onto
`ok`; an inconclusive probe always yields `unknown` with the raw evidence.

| verdict | meaning |
|---------|---------|
| `ok` | an anonymous visitor can fetch the dynamic |
| `self-visible` | present in the account's own view, absent or hidden for anonymous / other accounts |
| `deleted` | absent for both the account and anonymous callers |
| `unknown` | probe inconclusive: rate limit, auth failure, network error, or unrecognized API semantics |

The oracle is the anonymous detail endpoint
(`x/polymer/web-dynamic/v1/detail` with no cookie). Two secondary signals
support it: the anonymous space-feed listing, and `--probe-cookie` (a second
account). If the anonymous probe fails but the second account also cannot see
the dynamic, the verdict is `self-visible` — another account confirms the
invisibility. If both probes fail, the verdict is `unknown`, never `ok`.

## Reports

`--json-out` writes a machine-readable report:

- `window` — the actual `[from, to]` interval that was checked
- `checked_count` — how many dynamics were verified
- `coverage` — `complete`, or `incomplete` when feed pagination hit an error
  (an incomplete run exits `2`, never a silent pass)
- `findings` — every problematic dynamic with `dyn_id`, `permalink`
  (`https://t.bilibili.com/<id>`), `posted_at`, `type`, `text` snippet,
  `verdict`, `first_detected_at`, and raw API evidence per probe
  (`endpoint`, `http_status`, `api_code`, `api_message`, `attempts`)
- `checked` — all verified dynamics, for audit

stdout gets a human-readable table (dyn id, time, type, verdict, snippet) plus
a summary line.

## Late flips

A dynamic can turn self-visible days after posting. The state file maps
`dyn_id` to `posted_at`, `first_seen`, `last_verdict`, and `verdict_history`.
Every run re-verifies previously-`ok` dynamics whose `posted_at` is still
within `--recheck-hours` (default 96), even when they fall outside `--since`.
A problem that appears up to 96 hours after posting is still caught, and
`first_detected_at` records when it first showed up.

## Secret handling

`--cookie` accepts a file (or inline string) in any of three shapes:

1. biliup-style JSON — `{"cookie_info": {"cookies": [{"name": ..., "value": ...}]}}`
2. Netscape `cookies.txt` — tab-separated lines, `#HttpOnly_` prefix tolerated
3. raw `SESSDATA=...; bili_jct=...` string

Cookie values never appear in stdout, logs, reports, or the state file. The
tool logs only the cookie file path and a redacted fingerprint
(`SESSDATA len=222`). Redaction works at the data level before JSON
serialization, so a scrubbed value can never corrupt the report syntax. The
report deliberately omits the account mid — it equals the `DedeUserID` cookie
value — and one-character UI cookies (`'5'`, `'1'`) are not scrubbed, because
scrubbing single characters would destroy every number in the document. The
SESSDATA must be fresh: an expired session surfaces as `nav isLogin=false` and
exits `2`.

## Rate limiting and retries

Calls are spaced at least `--min-interval` seconds apart. Responses with
`-412`/`-352`/HTTP 412/5xx are retried with exponential backoff, bounded by
`--max-retries`. After five consecutive anonymous rate-limits the tool stops
hammering the anonymous probe (circuit breaker); the remaining verdicts become
`unknown` with `anon probe circuit open` evidence instead of burning the
budget. A rate-limited probe yields `unknown` plus the raw code and message.

## API facts observed live (2026-09-30)

These shaped the implementation and are worth knowing when reading evidence:

- B站 returns HTTP 412 for bare HTTP clients. The tool sends browser-like
  headers (`User-Agent`, `Referer: https://t.bilibili.com/`).
- The self feed `x/polymer/web-dynamic/v1/feed/space` paginates with an
  `offset` cursor, can return a pinned old dynamic at the front of page one,
  and delivers `pub_ts` as a decimal **string** — the window boundary is
  crossed per page, not per item.
- A dynamic hidden from outsiders returns `code=4101152, message="动态不可见"`
  on the anonymous detail probe. A nonexistent dyn id returns HTTP 200 with
  `code=500, message="Cannot read property 'only_fans' of undefined"`. Both
  count as definitive absence.
- `code=500, message="加载错误，请稍后再试"` is a soft risk-control response,
  not an absence proof — it yields `unknown` with the raw evidence.
- The anonymous space-feed listing is risk-banned (`-412 request was banned`)
  even with browser headers. The tool records that evidence and falls back to
  the anonymous detail probe, which does work — until risk control bans that
  too under burst probing, at which point the circuit breaker preserves the
  budget and the remaining verdicts become `unknown`.
- The self-feed `visible` field is recorded as evidence (`self_visible_flag`)
  but never decides a verdict; its exact semantics are unverified.

## Running

```sh
python3 -m unittest test_bili_dyn_visibility -v   # unit tests (mocked HTTP)
```

## Cron example

Run every 30 minutes, keep the state file stable across runs, append the table
to a log, and alert whenever the exit code is non-zero:

```cron
*/30 * * * * cd /opt/bili-dyn-visibility && /usr/bin/python3 bili_dyn_visibility.py \
  --cookie /etc/bili/cookies.json \
  --state /var/lib/bili-dyn-visibility/state.json \
  --json-out /var/lib/bili-dyn-visibility/report.json \
  >> /var/log/bili-dyn-visibility.log 2>&1 || \
  echo "bili-dyn-visibility exit $?" >> /var/log/bili-dyn-visibility.alerts
```

Exit `1` means findings (check `report.json`); exit `2` means the run could not
trust its own coverage (cookie expired, pagination error) and should be
investigated before anyone treats it as clean.
