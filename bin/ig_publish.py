"""Publish one rendered reel to Instagram, using storygasted's Graph API client.

    uv run --project ~/Desktop/projects/storygasted \
        python bin/ig_publish.py --video out/123.mp4 --caption-file cap.txt \
        --duration 11.6 --account interndoor

The third adapter, after bin/tts_once.py and bin/align_once.py, and a thin one
for the same reason: storygasted already drives Graph API v25.0 Reels end to
end, and a second implementation of a publish flow is a second thing to get
wrong. Prints one JSON line to stdout; everything else goes to stderr.

THE ACCOUNT GUARD IS THE POINT OF THIS FILE.

storygasted's own .env holds IG_USER_ID and IG_ACCESS_TOKEN for the account
`storygasted`, and its instagram.creds() reads exactly those names out of the
environment. Running this pipeline with that environment inherited would post
InternDoor job reels to the storygasted account, which is a mistake you cannot
take back once Instagram has distributed it.

So: credentials are read from INTERNDOOR's own .env, injected into the
environment before storygasted's module is imported, and then the live account
is asked who it is. If the username is not the one named by --account, nothing
is published. A wrong token is a refusal here, never a post.

The caption comes in on a FILE rather than an argument. It is multi-line, it
carries emoji and hashtags, and argv quoting for that across uv, sh and Python
is a way to silently truncate somebody's post.
"""
import argparse
import contextlib
import json
import os
import sys
from pathlib import Path

SG = Path.home() / "Desktop" / "projects" / "storygasted"
APP = Path(__file__).resolve().parent.parent


def load_env(path: Path) -> dict:
    """Minimal .env reader. No dependency, and it never touches os.environ."""
    out = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def die(msg: str) -> None:
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(1)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--caption-file", required=True)
    ap.add_argument("--duration", type=float, required=True)
    ap.add_argument("--account", required=True, help="the username that MUST own the token")
    ap.add_argument("--dry-run", action="store_true", help="check everything, publish nothing")
    a = ap.parse_args()

    video = Path(a.video)
    if not video.exists():
        die(f"no video at {video}")
    caption = Path(a.caption_file).read_text()

    env = load_env(APP / ".env")
    uid, tok = env.get("IG_USER_ID"), env.get("IG_ACCESS_TOKEN")
    if not uid or not tok:
        die("IG_USER_ID and IG_ACCESS_TOKEN are not in the interndoor .env. "
            f"They must belong to @{a.account}; storygasted's own credentials are "
            "for a different account and are deliberately not used.")

    # Injected BEFORE the import, because storygasted's need_env reads the
    # process environment. Overwriting rather than defaulting: if storygasted's
    # own values were already exported in this shell, they must not win.
    os.environ["IG_USER_ID"] = uid
    os.environ["IG_ACCESS_TOKEN"] = tok

    sys.path.insert(0, str(SG / "src"))
    from storygasted import config, instagram, serve_once

    c = config.load(SG / "config.yaml")

    with contextlib.redirect_stdout(sys.stderr):
        who = instagram.me()
    if who.get("username", "").lower() != a.account.lower():
        die(f"the token belongs to @{who.get('username') or 'unknown'}, not @{a.account} "
            "— refusing to publish. Put the InternDoor account's own "
            "IG_USER_ID and IG_ACCESS_TOKEN in the interndoor .env.")

    # Instagram's own rule, checked before anything is uploaded so a too-long
    # reel fails in a second rather than after a tunnel and a 60s fetch.
    if not 3 <= a.duration <= c.instagram.max_seconds:
        die(f"instagram reels via the api must be 3-{c.instagram.max_seconds}s, this is {a.duration:.1f}s")

    with contextlib.redirect_stdout(sys.stderr):
        quota = instagram.limits()
    usage = (quota.get("data", [{}])[0] or {}).get("quota_usage")
    cap = ((quota.get("data", [{}])[0] or {}).get("config") or {}).get("quota_total")

    if a.dry_run:
        print(json.dumps({"ok": True, "dryRun": True, "account": who,
                          "quotaUsed": usage, "quotaTotal": cap,
                          "captionChars": len(caption), "seconds": a.duration}))
        return

    with contextlib.redirect_stdout(sys.stderr):
        # shrink() only re-encodes when the file is over the size cap; an 11s
        # reel at ~1 MB passes straight through.
        path = instagram.shrink(video, c, a.duration)

        # Instagram FETCHES the video, so it has to be reachable from the
        # internet for the length of the fetch. serve_once opens a Cloudflare
        # quick tunnel and closes it again; it is the known-flaky part of this
        # whole path and the reason storygasted's notes name R2 as the fix.
        with serve_once.public_url(path) as url:
            cid = instagram._call("POST", f"{uid}/media", {
                "media_type": "REELS",
                "video_url": url,
                "caption": caption,
                "share_to_feed": "true" if c.instagram.share_to_feed else "false",
                "access_token": tok,
            })["id"]
            state = instagram._wait(cid, tok, c.instagram.timeout)

        if state != "FINISHED":
            die(f"instagram could not process the video (status {state})")

        mid = instagram._call("POST", f"{uid}/media_publish",
                              {"creation_id": cid, "access_token": tok})["id"]
        link = instagram.permalink(mid, tok)

    print(json.dumps({"ok": True, "id": mid, "url": link, "account": who,
                      "quotaUsed": usage, "quotaTotal": cap}))


if __name__ == "__main__":
    main()
