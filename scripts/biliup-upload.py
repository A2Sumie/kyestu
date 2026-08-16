#!/usr/bin/env python3

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass

from biliup.plugins.bili_webup import BiliBili, BiliWeb, Data

DEFAULT_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/146.0.0.0 Safari/537.36"
)


@dataclass
class FileInfo:
    video: str
    danmaku: object = None


def patch_biliup_headers(user_agent: str):
    original_init = BiliBili.__init__

    def patched_init(self, video):
        original_init(self, video)
        session = getattr(self, "_BiliBili__session", None)
        if session is None:
            return
        session.headers.update(
            {
                "user-agent": user_agent,
                "referer": "https://www.bilibili.com/",
                "origin": "https://www.bilibili.com",
                "accept": "application/json, text/plain, */*",
            }
        )

    BiliBili.__init__ = patched_init


def parse_args():
    parser = argparse.ArgumentParser(description="Upload videos to Bilibili via biliup.")
    parser.add_argument("--cookie-file", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--desc", default="")
    parser.add_argument("--source-url", required=True)
    parser.add_argument("--cover", default="")
    parser.add_argument("--submit-api", default="web")
    parser.add_argument("--line", default="AUTO")
    parser.add_argument("--tid", type=int, default=160)
    parser.add_argument("--threads", type=int, default=3)
    parser.add_argument("--copyright", type=int, choices=(1, 2), default=2)
    parser.add_argument("--tag", action="append", default=[])
    parser.add_argument("--user-agent", default=DEFAULT_BROWSER_UA)
    parser.add_argument("files", nargs="+")
    return parser.parse_args()


def main():
    args = parse_args()
    patch_biliup_headers(args.user_agent)
    uploader = BiliWeb(
        principal="idol-bbq-utils",
        data={
            "format_title": args.title,
            "url": args.source_url,
            "name": "idol-bbq-utils",
        },
        user={},
        user_cookie=args.cookie_file,
        submit_api=args.submit_api,
        lines=args.line,
        copyright=args.copyright,
        threads=args.threads,
        tid=args.tid,
        tags=args.tag,
        cover_path=args.cover or None,
        description=args.desc,
    )
    file_list = [FileInfo(video=video_path) for video_path in args.files]
    submit_result = upload_and_submit(uploader, file_list)
    print(
        json.dumps(
            {
                "ok": True,
                "title": args.title,
                "files": args.files,
                "tid": args.tid,
                "submit_result": submit_result,
            },
            ensure_ascii=False,
        )
    )


def upload_and_submit(uploader: BiliWeb, file_list):
    video = Data()
    video.dynamic = uploader.dynamic
    with BiliBili(video) as bili:
        bili.app_key = uploader.user.get("app_key")
        bili.appsec = uploader.user.get("appsec")
        bili.login(uploader.persistence_path, uploader.user_cookie)
        for file in file_list:
            try:
                video_part = bili.upload_file(file.video, uploader.lines, uploader.threads)
            except Exception as exc:
                raise RuntimeError(f"biliup upload_file failed for {file.video}: {explain_upload_error(exc)}") from exc
            video_part["title"] = sanitize_video_part_title(video_part.get("title"), file.video)
            video.append(video_part)
        video.title = uploader.data["format_title"][:80]
        if uploader.credits:
            video.desc_v2 = uploader.creditsToDesc_v2()
        else:
            video.desc_v2 = [
                {
                    "raw_text": uploader.desc,
                    "biz_id": "",
                    "type": 1,
                }
            ]
        video.desc = uploader.desc
        video.copyright = uploader.copyright
        if uploader.copyright == 2:
            video.source = uploader.data["url"]
        video.tid = uploader.tid
        video.set_tag(uploader.tags)
        if uploader.dtime:
            video.delay_time(int(time.time()) + uploader.dtime)
        if uploader.cover_path:
            try:
                video.cover = bili.cover_up(uploader.cover_path).replace("http:", "")
            except Exception as exc:
                print(
                    (
                        f"biliup cover_up failed for {uploader.cover_path}; "
                        f"continuing without custom cover: {explain_upload_error(exc)}"
                    ),
                    file=sys.stderr,
                )
        try:
            submit_result = bili.submit(uploader.submit_api)
        except Exception as exc:
            raise RuntimeError(f"biliup submit failed: {explain_upload_error(exc)}") from exc
        validate_submit_result(submit_result)
        return submit_result


def sanitize_video_part_title(title, video_path: str) -> str:
    candidate = str(title or os.path.splitext(os.path.basename(video_path))[0] or "").strip()
    candidate = re.sub(r'[\r\n\t<>:"/\\|?*\x00-\x1f]+', " ", candidate)
    candidate = re.sub(r"\s+", " ", candidate).strip()
    if not re.search(r"[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]", candidate):
        candidate = "视频"
    return candidate[:80]


def validate_submit_result(submit_result):
    if not isinstance(submit_result, dict):
        return
    code = submit_result.get("code")
    if code in (None, 0):
        return
    message = submit_result.get("message") or submit_result.get("msg") or json.dumps(
        submit_result,
        ensure_ascii=False,
    )
    raise RuntimeError(f"biliup submit returned code {code}: {message}")


def explain_upload_error(exc: Exception) -> str:
    message = str(exc)
    if message == "'chunk_size'":
        return (
            "biliup preupload response did not contain chunk_size; "
            "Bilibili likely rejected preupload first (common causes: upload rate limit code 601 or stale upload line)"
        )
    return message


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(explain_upload_error(exc), file=sys.stderr)
        raise
