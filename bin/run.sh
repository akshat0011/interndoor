#!/bin/bash
# Wrapper that launchd invokes. launchd hands every job a minimal PATH of
# /usr/bin:/bin:/usr/sbin:/sbin — Homebrew is not on it, so a bare `node` is
# "command not found". Locating node explicitly is the whole point of this file.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/Library/Logs/linkedin-watcher"
LOG="$LOG_DIR/run.log"

mkdir -p "$LOG_DIR"
cd "$HERE" || exit 1

# StandardOutPath appends forever with no rotation. Keep this one bounded.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5000000 ]; then
  tail -c 1000000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

find_node() {
  # /opt/homebrew/bin/node is a symlink that survives `brew upgrade node`;
  # never hardcode the versioned Cellar path it points at.
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.local/share/fnm/*/installation/bin/node \
    /usr/bin/node
  do
    [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  command -v node 2>/dev/null && return 0
  return 1
}

NODE="$(find_node || true)"
if [ -z "${NODE:-}" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [FATAL] node not found on PATH=$PATH" >> "$LOG"
  # A modal dialog is the only alert that reliably reaches the user from a
  # launchd context; notification banners are commonly swallowed.
  /usr/bin/osascript -e 'display alert "Internship watcher failed" message "node could not be found, so the scan did not run." giving up after 120' >/dev/null 2>&1
  exit 1
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') [START] node=$NODE args=$*" >> "$LOG"

# ---------------------------------------------------------------------------
# The post-queue helper, started here rather than as a second launchd agent.
#
# bin/queue-server.js serves the run report over http://127.0.0.1 so that its
# "Add to post queue" buttons have a same-origin API to talk to; a report opened
# as a file:// document has nowhere to send a click. It has to be long-lived —
# he queues listings across several runs and generates when he is ready — so it
# cannot be started and stopped around a scan.
#
# This file is the right place for it because it is the one that already knows
# where node is (launchd hands a job a minimal PATH; see find_node above), and
# because running every 30 minutes makes the check a free supervisor: if the
# helper ever dies, the next scan brings it back.
#
# Started only when nothing is answering on the port, and queue-server.js exits
# 0 on EADDRINUSE anyway, so a copy started by hand with `npm run queue` is
# never disturbed. Failure is silent by design — a scan must not depend on it.
# ---------------------------------------------------------------------------
if ! /usr/bin/curl -sS --max-time 2 -o /dev/null "http://127.0.0.1:${QUEUE_PORT:-4322}/api/health" 2>/dev/null; then
  "$NODE" --no-warnings=ExperimentalWarning "$HERE/bin/queue-server.js" >> "$LOG" 2>&1 &
  echo "$(date '+%Y-%m-%d %H:%M:%S') [QUEUE] started the post-queue helper (pid $!)" >> "$LOG"
fi

# ---------------------------------------------------------------------------
# ATS boards first, and deliberately so.
#
# This half needs no browser, no login and no pacing — it is JSON over HTTPS
# from endpoints built to be read — so it is both the cheapest and the most
# likely to succeed. Running it BEFORE the scan means a Brave that will not
# launch costs us the LinkedIn half of the slot and nothing else; run it after
# and a launch failure would take the whole slot down with it.
#
# --no-publish because the scan publishes once at the end, and publishing twice
# in a slot would mean two commits and two deploys for one round of collection.
# If the scan then fails before publishing, the next slot picks these up: they
# are already in the database.
# ---------------------------------------------------------------------------
"$NODE" --no-warnings=ExperimentalWarning "$HERE/bin/poll-ats.js" --no-publish >> "$LOG" 2>&1
# Capture before anything else runs. A command substitution in the echo below
# would overwrite $? with the exit status of `date`, which is always 0 — so
# every ATS failure was logged as a success.
ATS_STATUS=$?
echo "$(date '+%Y-%m-%d %H:%M:%S') [ATS EXIT $ATS_STATUS]" >> "$LOG"

"$NODE" --no-warnings=ExperimentalWarning "$HERE/src/index.js" "$@" >> "$LOG" 2>&1
STATUS=$?

echo "$(date '+%Y-%m-%d %H:%M:%S') [EXIT $STATUS]" >> "$LOG"

# ---------------------------------------------------------------------------
# The weekly roundup, asked about on every scan and written once a week.
#
# bin/weekly.js exits immediately unless it is on or after the configured hour
# on the configured weekday AND that calendar week has not been written yet, so
# this costs a process start 47 times a week and does real work once.
#
# Asked here rather than from a cron entry because this Mac is asleep for large
# parts of the day: a job that fires only at 10:00 exactly would be missed
# outright, while this one lands on the first scan after the machine wakes.
#
# After the scan and after publish, so the job pages every link points at are
# already on the site. Its exit status is deliberately discarded — a roundup is
# the least important thing this file does and must never change how the
# scheduler treats the scan.
# ---------------------------------------------------------------------------
"$NODE" --no-warnings=ExperimentalWarning "$HERE/bin/weekly.js" >> "$LOG" 2>&1 || true

# Web discovery, asked every scan and answered once a day.
#
# bin/discover-urls.js exits immediately unless today's sweep is outstanding.
# Once a day rather than once a scan because Google's free tier is 100 queries
# a day and this file fires 48 times; the searches are date-restricted anyway,
# so 48 sweeps would return the same pages and spend the quota by lunch.
#
# Status discarded for the same reason as the roundup: finding nothing, or
# finding no key, must never change how the scheduler treats the scan.
"$NODE" --no-warnings=ExperimentalWarning "$HERE/bin/discover-urls.js" >> "$LOG" 2>&1 || true

exit $STATUS
