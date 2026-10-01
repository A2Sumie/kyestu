#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Unit tests for bili_dyn_visibility (mocked HTTP, no network access).

Run:  python3 -m unittest test_bili_dyn_visibility -v
"""

import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bili_dyn_visibility as bdv  # noqa: E402

NOW = 1790750000  # fixed "now" (epoch) used by the injected clock
WINDOW_SECONDS = 96 * 3600
FROM_TS = NOW - WINDOW_SECONDS

SECRET_SESSDATA = "TOPSECRETSESSDATAVALUE0123456789abcdef"
SECRET_JCT = "TOPSECRETJCTVALUE0123456789abcdef"


# ---------------------------------------------------------------------------
# fake transport
# ---------------------------------------------------------------------------


class FakeFetch(object):
    """URL-substring routed fake transport. Responder sees (url, headers)."""

    def __init__(self, clock=None):
        self.routes = []
        self.calls = []
        self.clock = clock

    def add(self, substr, responder):
        self.routes.append((substr, responder))

    def __call__(self, url, headers, timeout=20):
        self.calls.append({
            "url": url,
            "headers": dict(headers),
            "timeout": timeout,
            "t": self.clock.t if self.clock else None,
        })
        for substr, responder in self.routes:
            if substr in url:
                return responder(url, headers)
        raise AssertionError("unexpected URL: %s" % url)

    def calls_to(self, substr):
        return [c for c in self.calls if substr in c["url"]]


class FakeClock(object):
    def __init__(self, t=1000.0):
        self.t = float(t)

    def time(self):
        return self.t

    def sleep(self, seconds):
        self.t += float(seconds)


def jr(obj, status=200):
    return bdv.FetchResult(status, json.dumps(obj).encode("utf-8"))


def feed_page(items, has_more=False, offset=""):
    return {"code": 0, "message": "0",
            "data": {"has_more": has_more, "offset": offset, "items": items}}


def feed_item(dyn_id, ts, typ="DYNAMIC_TYPE_DRAW", text="hello world", visible=True):
    return {"id_str": str(dyn_id), "type": typ, "visible": visible,
            "modules": {"module_author": {"pub_ts": ts},
                        "module_dynamic": {"desc": {"text": text}}}}


def detail_ok(dyn_id):
    return {"code": 0, "message": "0", "data": {"item": {"id_str": str(dyn_id)}}}


def detail_absent():
    # live-observed 2026-09-30 signature for a nonexistent/hidden dyn id
    return {"code": 500, "message": "Cannot read property 'only_fans' of undefined"}


def detail_absent_msg():
    return {"code": 410202, "message": "动态不存在"}


def detail_rate_limited(status=412):
    return {"code": -412, "message": "request was banned"}, status


def nav_ok(mid=297767646):
    return {"code": 0, "message": "OK",
            "data": {"isLogin": True, "mid": mid, "uname": "tester"}}


def biliup_cookie_json(sessdata=SECRET_SESSDATA, jct=SECRET_JCT):
    return json.dumps({
        "cookie_info": {"cookies": [
            {"name": "SESSDATA", "value": sessdata},
            {"name": "bili_jct", "value": jct},
            {"name": "DedeUserID", "value": "12345"},
        ]},
        "token_info": {"mid": 12345},
    })


def is_cookie(headers):
    return "Cookie" in headers


def make_fetch(feed_pages, detail_by_id, anon_feed=None, nav=None, clock=None):
    """Build a FakeFetch serving the standard endpoint set.

    feed_pages: list of feed_page dicts consumed in order for SELF feed calls.
    detail_by_id: {dyn_id: responder(url, headers) -> FetchResult} for detail calls.
    anon_feed: responder for anonymous feed/space calls (default: -412 banned).
    """
    fetch = FakeFetch(clock=clock)
    state = {"page": 0}

    def nav_r(url, headers):
        return jr(nav if nav is not None else nav_ok())

    def feed_r(url, headers):
        if not is_cookie(headers):
            if anon_feed is not None:
                return anon_feed(url, headers)
            body, status = detail_rate_limited()
            return jr(body, status)
        idx = state["page"]
        if idx >= len(feed_pages):
            raise AssertionError("self feed page %d requested beyond fixtures" % idx)
        state["page"] += 1
        return jr(feed_pages[idx])

    def detail_r(url, headers):
        dyn_id = url.split("id=")[1].split("&")[0]
        responder = detail_by_id.get(dyn_id)
        if responder is None:
            raise AssertionError("no detail fixture for dyn id %s" % dyn_id)
        return responder(url, headers)

    fetch.add("web-interface/nav", nav_r)
    fetch.add("feed/space", feed_r)
    fetch.add("web-dynamic/v1/detail", detail_r)
    return fetch


def run_tool(fetch, argv_extra=None, cookie_path=None, state_path=None,
             json_path=None, now=NOW):
    out, err = io.StringIO(), io.StringIO()
    argv = ["--cookie", cookie_path, "--state", state_path, "--json-out", json_path,
            "--max-retries", "1"]
    if argv_extra:
        argv.extend(argv_extra)
    code = bdv.run(argv, fetch=fetch, now_fn=lambda: now,
                   sleep_fn=lambda s: None, out=out, err=err)
    return code, out.getvalue(), err.getvalue()


# ---------------------------------------------------------------------------
# cookie shapes
# ---------------------------------------------------------------------------


class CookieShapeTests(unittest.TestCase):
    def test_biliup_json_shape(self):
        jar = bdv.parse_cookie_text(biliup_cookie_json())
        self.assertEqual(jar["SESSDATA"], SECRET_SESSDATA)
        self.assertEqual(jar["bili_jct"], SECRET_JCT)
        self.assertIn("DedeUserID", jar)

    def test_netscape_shape(self):
        text = (
            "# Netscape HTTP Cookie File\n"
            ".bilibili.com\tTRUE\t/\tFALSE\t0\tbuvid3\tabc123\n"
            "#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\t%s\n" % SECRET_SESSDATA
        )
        jar = bdv.parse_cookie_text(text)
        self.assertEqual(jar["SESSDATA"], SECRET_SESSDATA)
        self.assertEqual(jar["buvid3"], "abc123")

    def test_raw_name_value_shape(self):
        jar = bdv.parse_cookie_text("SESSDATA=%s; bili_jct=%s" % (SECRET_SESSDATA, SECRET_JCT))
        self.assertEqual(jar["SESSDATA"], SECRET_SESSDATA)
        self.assertEqual(jar["bili_jct"], SECRET_JCT)

    def test_load_cookie_inline_and_fingerprint(self):
        jar, meta = bdv.load_cookie("SESSDATA=%s" % SECRET_SESSDATA)
        self.assertEqual(meta["source"], "<inline>")
        self.assertEqual(meta["fingerprint"], "SESSDATA len=%d" % len(SECRET_SESSDATA))
        self.assertNotIn(SECRET_SESSDATA, meta["fingerprint"])

    def test_missing_sessdata_rejected(self):
        with self.assertRaises(bdv.CookieError):
            bdv.parse_cookie_text("bili_jct=only")

    def test_redact_scrubs_registered_secrets(self):
        bdv.parse_cookie_text("SESSDATA=%s" % SECRET_SESSDATA)
        self.assertNotIn(SECRET_SESSDATA, bdv.redact("x %s y" % SECRET_SESSDATA))


# ---------------------------------------------------------------------------
# verdicts
# ---------------------------------------------------------------------------


class VerdictTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bdv-test-")
        self.cookie_path = os.path.join(self.tmp, "cookie.json")
        with open(self.cookie_path, "w", encoding="utf-8") as fh:
            fh.write(biliup_cookie_json())
        self.state_path = os.path.join(self.tmp, "state.json")
        self.json_path = os.path.join(self.tmp, "report.json")

    def read_report(self):
        with open(self.json_path, "r", encoding="utf-8") as fh:
            return json.load(fh)

    def read_state(self):
        if not os.path.isfile(self.state_path):
            return {}
        with open(self.state_path, "r", encoding="utf-8") as fh:
            return json.load(fh)

    # -- ok ---------------------------------------------------------------
    def test_verdict_ok(self):
        fetch = make_fetch(
            [feed_page([feed_item(101, NOW - 3600)])],
            {"101": lambda u, h: jr(detail_ok(101))})
        code, out, err = run_tool(fetch, cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_CLEAN, err)
        report = self.read_report()
        self.assertEqual(report["checked_count"], 1)
        self.assertEqual(report["verdict_counts"]["ok"], 1)
        self.assertEqual(report["findings"], [])
        self.assertEqual(report["checked"][0]["verdict"], "ok")
        self.assertEqual(report["checked"][0]["permalink"], "https://t.bilibili.com/101")

    # -- self-visible ------------------------------------------------------
    def test_verdict_self_visible(self):
        fetch = make_fetch(
            [feed_page([feed_item(202, NOW - 7200, typ="DYNAMIC_TYPE_WORD", text="仅自己可见测试")])],
            {"202": lambda u, h: jr(detail_absent())})
        code, out, err = run_tool(fetch, cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_FINDINGS, err)
        report = self.read_report()
        self.assertEqual(report["verdict_counts"]["self-visible"], 1)
        finding = report["findings"][0]
        self.assertEqual(finding["dyn_id"], "202")
        self.assertEqual(finding["verdict"], "self-visible")
        self.assertEqual(finding["type"], "DYNAMIC_TYPE_WORD")
        self.assertIn("仅自己可见测试", finding["text"])
        self.assertIn("first_detected_at", finding)
        ev = finding["evidence"][0]
        self.assertEqual(ev["probe"], "anon-detail")
        self.assertIn("web-dynamic/v1/detail", ev["endpoint"])
        self.assertIn("http_status", ev)
        self.assertIn("api_code", ev)
        self.assertIn("self-visible", out)

    def test_verdict_self_visible_alternate_absent_signature(self):
        fetch = make_fetch(
            [feed_page([feed_item(203, NOW - 7200)])],
            {"203": lambda u, h: jr(detail_absent_msg())})
        code, out, err = run_tool(fetch, cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_FINDINGS, err)
        self.assertEqual(self.read_report()["verdict_counts"]["self-visible"], 1)

    def test_verdict_self_visible_hidden_signature_4101152(self):
        # live-observed 2026-09-30: hidden dynamics return 4101152 动态不可见
        fetch = make_fetch(
            [feed_page([feed_item(204, NOW - 7200)])],
            {"204": lambda u, h: jr({"code": 4101152, "message": "动态不可见"})})
        code, out, err = run_tool(fetch, cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_FINDINGS, err)
        finding = self.read_report()["findings"][0]
        self.assertEqual(finding["verdict"], "self-visible")
        self.assertEqual(finding["evidence"][0]["api_code"], 4101152)

    def test_string_pub_ts_drives_window_filtering(self):
        # live API returns pub_ts as a decimal string
        old_item = feed_item(205, FROM_TS - 9999)
        old_item["modules"]["module_author"]["pub_ts"] = str(FROM_TS - 9999)
        new_item = feed_item(206, NOW - 3600)
        new_item["modules"]["module_author"]["pub_ts"] = str(NOW - 3600)
        fetch = make_fetch([feed_page([old_item, new_item], has_more=False)],
                           {"206": lambda u, h: jr(detail_ok(206))})
        code, out, err = run_tool(fetch, cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_CLEAN, err)
        report = self.read_report()
        self.assertEqual(report["checked_count"], 1)  # out-of-window item filtered
        self.assertEqual(report["checked"][0]["dyn_id"], "206")
        self.assertEqual(report["checked"][0]["posted_at"], bdv.iso_utc(NOW - 3600))

    # -- deleted (state item absent for both sides) ------------------------
    def test_verdict_deleted_via_state(self):
        state = {
            "303": {"dyn_id": "303", "posted_ts": NOW - 2 * 3600,
                    "posted_at": bdv.iso_utc(NOW - 2 * 3600),
                    "first_seen": bdv.iso_utc(NOW - 2 * 3600),
                    "last_verdict": "ok",
                    "verdict_history": [{"ts": bdv.iso_utc(NOW - 2 * 3600), "verdict": "ok"}]}
        }
        with open(self.state_path, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
        fetch = make_fetch(
            [feed_page([])],
            {"303": lambda u, h: jr(detail_absent())})
        code, out, err = run_tool(fetch, cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_FINDINGS, err)
        report = self.read_report()
        self.assertEqual(report["verdict_counts"]["deleted"], 1)
        self.assertEqual(report["findings"][0]["dyn_id"], "303")
        probes = [e["probe"] for e in report["findings"][0]["evidence"]]
        self.assertIn("self-detail", probes)
        self.assertIn("anon-detail", probes)

    # -- pagination crossing the window boundary ---------------------------
    def test_pagination_crosses_window_boundary(self):
        old_ts = FROM_TS - 5000  # outside the window
        page1 = feed_page([feed_item(401, NOW - 3600), feed_item(402, NOW - 7200)],
                          has_more=True, offset="o1")
        page2 = feed_page([feed_item(403, NOW - 80000)], has_more=True, offset="o2")
        page3 = feed_page([feed_item(404, old_ts)], has_more=True, offset="o3")
        page4 = feed_page([feed_item(405, old_ts - 100)], has_more=True, offset="o4")
        fetch = make_fetch([page1, page2, page3, page4],
                           {str(i): (lambda u, h: jr(detail_ok(u.split("id=")[1].split("&")[0])))
                            for i in (401, 402, 403, 404, 405)})
        code, out, err = run_tool(fetch, cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_CLEAN, err)
        report = self.read_report()
        self.assertEqual(report["checked_count"], 3)  # 401 402 403 only
        self.assertEqual(report["coverage"], "complete")
        self.assertEqual(report["window"]["from_ts"], FROM_TS)
        self.assertEqual(report["window"]["to_ts"], NOW)
        # boundary crossed on page 3 -> page 4 never fetched (self feed carries a Cookie)
        self_feed_calls = [c for c in fetch.calls_to("feed/space") if is_cookie(c["headers"])]
        self.assertEqual(len(self_feed_calls), 3)
        # out-of-window dynamics never probed
        self.assertEqual(len(fetch.calls_to("web-dynamic/v1/detail")), 3)
        ids = sorted(r["dyn_id"] for r in report["checked"])
        self.assertEqual(ids, ["401", "402", "403"])

    def test_pagination_error_marks_coverage_incomplete(self):
        page1 = feed_page([feed_item(501, NOW - 3600)], has_more=True, offset="o1")
        fetch = make_fetch([page1],
                           {"501": lambda u, h: jr(detail_ok(501))})
        fetch.add("offset=o1", lambda u, h: jr({"code": -500, "message": "boom"}, 500))
        code, out, err = run_tool(fetch, cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_ERROR)
        report = self.read_report()
        self.assertEqual(report["coverage"], "incomplete")
        self.assertTrue(report["coverage_notes"])
        self.assertIn("coverage=incomplete", out)

    # -- late flip via state ----------------------------------------------
    def test_late_flip_recheck_via_state(self):
        old_ts = NOW - 48 * 3600  # outside a 24h --since window, inside 96h recheck
        state = {
            "601": {"dyn_id": "601", "posted_ts": old_ts, "posted_at": bdv.iso_utc(old_ts),
                    "first_seen": bdv.iso_utc(old_ts), "last_verdict": "ok",
                    "type": "DYNAMIC_TYPE_DRAW", "text": "old post",
                    "verdict_history": [{"ts": bdv.iso_utc(old_ts), "verdict": "ok"}]},
            "602": {"dyn_id": "602", "posted_ts": NOW - 3600, "posted_at": bdv.iso_utc(NOW - 3600),
                    "first_seen": bdv.iso_utc(NOW - 3600), "last_verdict": "ok",
                    "verdict_history": [{"ts": bdv.iso_utc(NOW - 3600), "verdict": "ok"}]},
        }
        with open(self.state_path, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
        fetch = make_fetch(
            [feed_page([])],  # 24h window empty; 601 lives outside it
            {"601": lambda u, h: jr(detail_absent()) if not is_cookie(h) else jr(detail_ok(601)),
             "602": lambda u, h: jr(detail_ok(602))})
        code, out, err = run_tool(fetch, ["--since", "24h"], cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_FINDINGS, err)
        report = self.read_report()
        findings = {f["dyn_id"]: f for f in report["findings"]}
        self.assertIn("601", findings)
        self.assertEqual(findings["601"]["verdict"], "self-visible")
        self.assertIn("602", str(report["checked"]))  # still verified
        self.assertEqual(report["verdict_counts"]["ok"], 1)
        # first_detected_at = now on first detection
        self.assertEqual(findings["601"]["first_detected_at"], bdv.iso_utc(NOW))

        # second run: first_detected_at is preserved from the first detection
        fetch2 = make_fetch(
            [feed_page([])],
            {"601": lambda u, h: jr(detail_absent()) if not is_cookie(h) else jr(detail_ok(601)),
             "602": lambda u, h: jr(detail_ok(602))})
        code2, _, _ = run_tool(fetch2, ["--since", "24h"], cookie_path=self.cookie_path,
                               state_path=self.state_path, json_path=self.json_path,
                               now=NOW + 600)
        self.assertEqual(code2, bdv.EXIT_FINDINGS)
        report2 = self.read_report()
        findings2 = {f["dyn_id"]: f for f in report2["findings"]}
        self.assertEqual(findings2["601"]["first_detected_at"], bdv.iso_utc(NOW))
        # state was updated with the new verdict
        state_after = self.read_state()
        self.assertEqual(state_after["601"]["last_verdict"], "self-visible")
        # seeded ok entry + one entry per run
        self.assertEqual(len(state_after["601"]["verdict_history"]), 3)

    # -- rate limit --------------------------------------------------------
    def test_rate_limit_yields_unknown_not_ok(self):
        def banned(url, headers):
            body, status = detail_rate_limited()
            return jr(body, status)

        fetch = make_fetch([feed_page([feed_item(701, NOW - 3600)])],
                           {"701": banned})
        code, out, err = run_tool(fetch, cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_FINDINGS)
        report = self.read_report()
        self.assertEqual(report["verdict_counts"]["unknown"], 1)
        self.assertEqual(report["findings"][0]["verdict"], "unknown")
        ev = report["findings"][0]["evidence"][0]
        self.assertEqual(ev["api_code"], -412)
        self.assertEqual(ev["error_kind"], "rate-limit")
        # bounded retries: 1 initial + 1 retry (--max-retries 1)
        self.assertEqual(len(fetch.calls_to("web-dynamic/v1/detail")), 2)

    def test_second_opinion_can_confirm_self_visible(self):
        def banned(url, headers):
            body, status = detail_rate_limited()
            return jr(body, status)

        probe_cookie = os.path.join(self.tmp, "probe.json")
        with open(probe_cookie, "w", encoding="utf-8") as fh:
            fh.write(biliup_cookie_json(sessdata="PROBESESSDATAVALUE0000000000",
                                        jct="PROBEJCTVALUE0000000000"))
        fetch = make_fetch(
            [feed_page([feed_item(801, NOW - 3600)])],
            {"801": lambda u, h: jr(detail_absent()) if "PROBESESSDATA" in h.get("Cookie", "")
             else banned(u, h)})
        code, out, err = run_tool(fetch, ["--probe-cookie", probe_cookie],
                                  cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_FINDINGS)
        report = self.read_report()
        self.assertEqual(report["findings"][0]["verdict"], "self-visible")
        probes = [e["probe"] for e in report["findings"][0]["evidence"]]
        self.assertIn("probe-account-detail", probes)

    # -- types filter ------------------------------------------------------
    def test_types_filter(self):
        fetch = make_fetch(
            [feed_page([feed_item(901, NOW - 3600, typ="DYNAMIC_TYPE_DRAW"),
                        feed_item(902, NOW - 7200, typ="DYNAMIC_TYPE_WORD")])],
            {"901": lambda u, h: jr(detail_ok(901)),
             "902": lambda u, h: jr(detail_ok(902))})
        code, out, err = run_tool(fetch, ["--types", "word"],
                                  cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_CLEAN, err)
        report = self.read_report()
        self.assertEqual(report["checked_count"], 1)
        self.assertEqual(report["checked"][0]["dyn_id"], "902")

    # -- secret hygiene ----------------------------------------------------
    def test_redaction_json_safe_when_cookie_value_equals_mid(self):
        # the DedeUserID cookie value IS the account mid; a naive string
        # replace would corrupt the JSON number token (seen live 2026-09-30)
        cookie_path = os.path.join(self.tmp, "cookie-mid.json")
        with open(cookie_path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps({"cookie_info": {"cookies": [
                {"name": "SESSDATA", "value": SECRET_SESSDATA},
                {"name": "DedeUserID", "value": "297767646"},
            ]}}))
        fetch = make_fetch([feed_page([feed_item(207, NOW - 3600)])],
                           {"207": lambda u, h: jr(detail_ok(207))})
        code, out, err = run_tool(fetch, ["-v"], cookie_path=cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_CLEAN, err)
        with open(self.json_path, "r", encoding="utf-8") as fh:
            report_text = fh.read()
        report = json.loads(report_text)  # must still parse: redaction is JSON-safe
        self.assertNotIn("mid", report)
        with open(self.state_path, "r", encoding="utf-8") as fh:
            state_text = fh.read()
        json.loads(state_text)
        for blob in (report_text, state_text, out, err):
            self.assertNotIn(SECRET_SESSDATA, blob)
            self.assertNotIn("297767646", blob)

    def test_cookie_values_never_leak(self):
        fetch = make_fetch(
            [feed_page([feed_item(951, NOW - 3600)])],
            {"951": lambda u, h: jr(detail_absent())})
        code, out, err = run_tool(fetch, ["-v"], cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_FINDINGS)
        with open(self.json_path, "r", encoding="utf-8") as fh:
            report_text = fh.read()
        with open(self.state_path, "r", encoding="utf-8") as fh:
            state_text = fh.read()
        for blob in (report_text, state_text, out, err):
            self.assertNotIn(SECRET_SESSDATA, blob)
            self.assertNotIn(SECRET_JCT, blob)
        # fingerprint is the only credential-adjacent datum, and it is redacted
        report = json.loads(report_text)
        self.assertEqual(report["cookie"]["fingerprint"],
                         "SESSDATA len=%d" % len(SECRET_SESSDATA))

    # -- mid resolution ----------------------------------------------------
    def test_mid_auto_resolved_and_given(self):
        fetch = make_fetch([feed_page([])], {})
        code, out, err = run_tool(fetch, cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_CLEAN, err)
        self.assertEqual(len(fetch.calls_to("web-interface/nav")), 1)
        self.assertEqual(len(fetch.calls_to("host_mid=297767646")), 3)  # self feed + anon feed (retried once)

        fetch2 = make_fetch([feed_page([])], {})
        code2, _, _ = run_tool(fetch2, ["--mid", "42"], cookie_path=self.cookie_path,
                               state_path=self.state_path, json_path=self.json_path,
                               now=NOW + 10)
        self.assertEqual(code2, bdv.EXIT_CLEAN)
        self.assertEqual(len(fetch2.calls_to("web-interface/nav")), 0)
        self.assertEqual(len(fetch2.calls_to("host_mid=42")), 3)

    def test_nav_failure_is_execution_error(self):
        fetch = make_fetch([feed_page([])], {},
                           nav={"code": 0, "message": "OK",
                                "data": {"isLogin": False, "mid": 297767646}})
        code, out, err = run_tool(fetch, cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_ERROR)
        self.assertIn("not logged in", err)

    def test_unknown_api_semantics_never_become_ok(self):
        # a non-zero code we do not understand must not be mapped onto ok
        fetch = make_fetch(
            [feed_page([feed_item(971, NOW - 3600)])],
            {"971": lambda u, h: jr({"code": -666, "message": "mystery failure"})})
        code, out, err = run_tool(fetch, cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_FINDINGS)
        self.assertEqual(self.read_report()["verdict_counts"]["unknown"], 1)

    def test_network_error_yields_unknown_with_evidence(self):
        def boom(url, headers):
            raise OSError("connection reset")

        fetch = make_fetch([feed_page([feed_item(972, NOW - 3600)])],
                           {"972": boom})
        code, out, err = run_tool(fetch, cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_FINDINGS)
        finding = self.read_report()["findings"][0]
        self.assertEqual(finding["verdict"], "unknown")
        self.assertEqual(finding["evidence"][0]["error_kind"], "network")

    def test_forward_text_falls_back_to_orig(self):
        forward = {"id_str": "973", "type": "DYNAMIC_TYPE_FORWARD", "visible": True,
                   "modules": {"module_author": {"pub_ts": NOW - 3600},
                               "module_dynamic": {}}}
        forward["orig"] = feed_item(1, NOW - 7200, text="原动态内容")
        self.assertEqual(bdv.item_text(forward), "原动态内容")
        self.assertEqual(bdv.item_visible_flag(forward), True)

    def test_anon_feed_listing_makes_ok_without_detail_probe(self):
        def anon_feed(url, headers):
            return jr(feed_page([feed_item(981, NOW - 3600)], has_more=True, offset="p2")) \
                if "offset=p2" not in url else jr(feed_page([feed_item(982, NOW - 7200)]))

        fetch = make_fetch([feed_page([feed_item(981, NOW - 3600),
                                       feed_item(982, NOW - 7200)])],
                           {}, anon_feed=anon_feed)
        code, out, err = run_tool(fetch, cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_CLEAN, err)
        report = self.read_report()
        self.assertEqual(report["verdict_counts"]["ok"], 2)
        # verdicts came from the anonymous listing, no detail probes fired
        self.assertEqual(len(fetch.calls_to("web-dynamic/v1/detail")), 0)
        self.assertEqual(report["checked"][0]["evidence"][0]["probe"], "anon-space-feed")

    def test_pagination_stall_marks_incomplete(self):
        page1 = feed_page([feed_item(991, NOW - 3600)], has_more=True, offset="same")
        page2 = feed_page([feed_item(991, NOW - 3600)], has_more=True, offset="same")
        fetch = make_fetch([page1, page2], {"991": lambda u, h: jr(detail_ok(991))})
        code, out, err = run_tool(fetch, cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_ERROR)
        self.assertEqual(self.read_report()["coverage"], "incomplete")
        self.assertTrue(any("stalled" in n for n in self.read_report()["coverage_notes"]))

    def test_page_cap_marks_incomplete(self):
        page1 = feed_page([feed_item(992, NOW - 3600)], has_more=True, offset="n1")
        page2 = feed_page([feed_item(993, NOW - 7200)], has_more=True, offset="n2")
        fetch = make_fetch([page1, page2], {"992": lambda u, h: jr(detail_ok(992)),
                                            "993": lambda u, h: jr(detail_ok(993))})
        code, out, err = run_tool(fetch, ["--max-pages", "1"],
                                  cookie_path=self.cookie_path,
                                  state_path=self.state_path, json_path=self.json_path)
        self.assertEqual(code, bdv.EXIT_ERROR)
        self.assertEqual(self.read_report()["coverage"], "incomplete")
        self.assertTrue(any("page cap" in n for n in self.read_report()["coverage_notes"]))


class HelperUnitTests(unittest.TestCase):
    def test_json_top_level_cookies_shape(self):
        jar = bdv.parse_cookie_text(
            '{"cookies": [{"name": "SESSDATA", "value": "abc123"}]}')
        self.assertEqual(jar["SESSDATA"], "abc123")

    def test_json_malformed_and_unrecognized_shapes(self):
        with self.assertRaises(bdv.CookieError):
            bdv.parse_cookie_text("{not json")
        with self.assertRaises(bdv.CookieError):
            bdv.parse_cookie_text('{"cookie_info": {"cookies": "nope"}}')
        with self.assertRaises(bdv.CookieError):
            bdv.parse_cookie_text('{"cookie_info": {"cookies": [1, 2]}}')

    def test_netscape_edge_lines(self):
        text = (
            "# comment line\n"
            ".bilibili.com\tTRUE\t/\tFALSE\t0\t\temptyname\n"
            "a=1\tb=2\n"
            ".bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\tvalue999\n"
        )
        jar = bdv.parse_cookie_text(text)
        self.assertEqual(jar["SESSDATA"], "value999")
        self.assertNotIn("", jar)

    def test_item_text_from_opus_and_blocks(self):
        opus_item = {"modules": {"module_dynamic": {"major": {"opus": {"summary": {"text": "opus内容"}}}}}}
        self.assertEqual(bdv.item_text(opus_item), "opus内容")
        draw_item = {"modules": {"module_dynamic": {"major": {"draw": {"title": "图集标题"}}}}}
        self.assertEqual(bdv.item_text(draw_item), "图集标题")
        article_item = {"modules": {"module_dynamic": {"major": {"article": {"desc": "文章摘要"}}}}}
        self.assertEqual(bdv.item_text(article_item), "文章摘要")

    def test_classify_code0_without_item_is_absent(self):
        result = bdv.ApiResult("u", 200, 0, "0", {"data": {}}, None)
        self.assertEqual(bdv.classify_detail(result), bdv.OUTCOME_ABSENT)


# ---------------------------------------------------------------------------
# client behaviour (throttle / retries)
# ---------------------------------------------------------------------------


class FakeHTTPResponse(object):
    def __init__(self, status, body, headers=None):
        self.status = status
        self._body = body
        self.headers = headers or {"Content-Type": "application/json"}

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class DefaultFetchTests(unittest.TestCase):
    def test_default_fetch_success(self):
        with mock.patch("urllib.request.urlopen",
                        return_value=FakeHTTPResponse(200, b'{"code":0}')):
            result = bdv.default_fetch("https://example/api", {"User-Agent": "t"})
        self.assertEqual(result.status, 200)
        self.assertEqual(json.loads(result.body), {"code": 0})

    def test_default_fetch_http_error_returns_body(self):
        http_err = urllib.error.HTTPError(
            "https://example/api", 412, "banned", {}, io.BytesIO(b'{"code":-412}'))
        with mock.patch("urllib.request.urlopen", side_effect=http_err):
            result = bdv.default_fetch("https://example/api", {"User-Agent": "t"})
        self.assertEqual(result.status, 412)
        self.assertIn(b"-412", result.body)


class ClientTests(unittest.TestCase):
    def test_min_interval_between_calls(self):
        clock = FakeClock()
        fetch = FakeFetch(clock=clock)
        fetch.add("example", lambda u, h: jr({"code": 0, "data": {}}))
        api = bdv.BiliAPI(fetch=fetch, min_interval=1.0, max_retries=0,
                          sleep=clock.sleep, time_fn=clock.time)
        for _ in range(3):
            api.get("https://example/api?a=1")
        times = [c["t"] for c in fetch.calls]
        gaps = [b - a for a, b in zip(times, times[1:])]
        self.assertTrue(all(gap >= 1.0 - 1e-6 for gap in gaps), gaps)

    def test_backoff_retries_are_bounded(self):
        clock = FakeClock()
        fetch = FakeFetch(clock=clock)
        fetch.add("example", lambda u, h: jr({"code": -412, "message": "banned"}))
        api = bdv.BiliAPI(fetch=fetch, min_interval=1.0, max_retries=3,
                          sleep=clock.sleep, time_fn=clock.time)
        result = api.get("https://example/api?a=1")
        self.assertEqual(len(fetch.calls), 4)  # 1 + 3 bounded retries
        self.assertEqual(result.error_kind, "rate-limit")
        self.assertEqual(result.attempts, 4)

    def test_retry_recovers_on_transient(self):
        clock = FakeClock()
        fetch = FakeFetch(clock=clock)
        state = {"n": 0}

        def flaky(url, headers):
            state["n"] += 1
            if state["n"] < 3:
                return jr({"code": -412, "message": "banned"})
            return jr({"code": 0, "data": {"ok": True}})

        fetch.add("example", flaky)
        api = bdv.BiliAPI(fetch=fetch, min_interval=1.0, max_retries=3,
                          sleep=clock.sleep, time_fn=clock.time)
        result = api.get("https://example/api?a=1")
        self.assertTrue(result.ok)
        self.assertEqual(result.attempts, 3)

    def test_headers_are_browser_like_and_cookie_scoped(self):
        clock = FakeClock()
        fetch = FakeFetch(clock=clock)
        fetch.add("example", lambda u, h: jr({"code": 0, "data": {}}))
        api = bdv.BiliAPI(fetch=fetch, cookie="SESSDATA=zzz", min_interval=0,
                          max_retries=0, sleep=clock.sleep, time_fn=clock.time)
        api.get("https://example/api?a=1")
        api.get("https://example/api?a=1", cookie=None)  # explicit anonymous
        headers = [c["headers"] for c in fetch.calls]
        self.assertIn("Mozilla/5.0", headers[0]["User-Agent"])
        self.assertIn("Cookie", headers[0])
        self.assertNotIn("Cookie", headers[1])

    def test_duration_parsing(self):
        self.assertEqual(bdv.parse_duration("96h"), 96 * 3600)
        self.assertEqual(bdv.parse_duration("4d"), 4 * 86400)
        self.assertEqual(bdv.parse_duration("1d12h"), 86400 + 12 * 3600)
        self.assertEqual(bdv.parse_duration("96"), 96 * 3600)
        with self.assertRaises(ValueError):
            bdv.parse_duration("banana")


if __name__ == "__main__":
    unittest.main()
