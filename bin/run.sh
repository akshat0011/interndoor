#!/bin/bash
# Wrapper that launchd invokes. launchd hands every job a minimal PATH of
# /usr/bin:/bin:/usr/sbin:/sbin — Homebrew is not on it, so a bare `node` is
# "command not found". Locating node explicitly is the whole point of this file.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/Library/Logs/interndoor"
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
# Boards named in the apply links of postings already opened, once a day. It is
# the only discovery method that guesses nothing, and it runs just before the
# poll so a board found here is read in the same slot. `--daily` makes every
# other call a process start and nothing more; failure must never stop the poll.
"$NODE" --no-warnings=ExperimentalWarning "$HERE/bin/discover-ats.js" --apply-links --daily >> "$LOG" 2>&1 || true

"$NODE" --no-warnings=ExperimentalWarning "$HERE/bin/poll-ats.js" --no-publish >> "$LOG" 2>&1
# Capture before anything else runs. A command substitution in the echo below
# would overwrite $? with the exit status of `date`, which is always 0 — so
# every ATS failure was logged as a success.
ATS_STATUS=$?
echo "$(date '+%Y-%m-%d %H:%M:%S') [ATS EXIT $ATS_STATUS]" >> "$LOG"

# TWO PHASES, THE HOME BOARD FIRST (26 Sep 2026). One scan used to walk every
# region and publish once at the end, so India's new roles waited for the US
# walk and its enrichment — 20-47 minutes from the start of the run to the
# site. Now the home region is walked, enriched, published and posted to its
# channel first, and then everything else. A home phase that found no network
# (75) skips the rest, exactly as the whole scan used to. The rest phase's own
# 75 is not passed on: the home board has just been reached, and a fast retry
# would walk it again for nothing.
# INTERNSHIPS, THEN FULL-TIME, EACH PUBLISHED ON ITS OWN (1 Oct 2026, his
# call: "india internship - enrich - publish, then india full time - enrich -
# publish, every 30 mins"). The internship walk is enriched and published
# before the full-time walk starts, so it never waits on it. The full-time
# phase deploys only when it found something new (src/index.js, laterPhase).
# THE REST-OF-WORLD PHASE (--regions=-home) IS GONE: India is the only board
# since 30 Sep, and that phase only ever wrote an empty run row for the paused
# US search. A US/UK/CA search back on needs it back.
# One press of the scan view's stop button stops BOTH phases of this tick
# (src/scanstop.js): each phase honours a stop made at or after this moment.
# THE NIGHTLY RECOVERY SLOT (14 Oct 2026, his call; src/recovery.js). Once a
# night, in the quietest hour (config.json recovery.hour, 04:00 IST), both
# phases read LinkedIn's PUBLIC search over a 24h window instead of the hourly
# signed-in walk, to recover anything it missed ("recover"). For the rest of
# that hour no LinkedIn walk runs at all ("hold"), so the last signed-in walk
# is in the hour before and the next one in the hour after. Any other answer,
# or none, is a normal tick: only an exact "recover" or "hold" changes it.
SLOT_LINE="$("$NODE" --no-warnings=ExperimentalWarning "$HERE/bin/recovery-slot.js" 2>> "$LOG" | tail -n 1)"
read -r SCAN_SLOT RECOVERY_HOURS <<< "$SLOT_LINE"
case "$RECOVERY_HOURS" in ''|*[!0-9]*) RECOVERY_HOURS=24 ;; esac
PHASE_ARGS=()
if [ "$SCAN_SLOT" = "recover" ]; then
  PHASE_ARGS=(--recovery --source=guest "--window-hours=$RECOVERY_HOURS")
  echo "$(date '+%Y-%m-%d %H:%M:%S') [RECOVERY] nightly public-search recovery, ${RECOVERY_HOURS}h window, both phases" >> "$LOG"
fi

STATUS=0
if [ "$SCAN_SLOT" = "hold" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') [HOLD] tonight's recovery already ran this hour — no LinkedIn walk until the hour ends" >> "$LOG"
else
export INTERNDOOR_TICK_AT="$(($(date +%s) * 1000))"
"$NODE" --no-warnings=ExperimentalWarning "$HERE/src/index.js" "$@" --regions=home --kind=intern ${PHASE_ARGS[@]+"${PHASE_ARGS[@]}"} >> "$LOG" 2>&1
STATUS=$?
echo "$(date '+%Y-%m-%d %H:%M:%S') [EXIT intern $STATUS]" >> "$LOG"
if [ "$STATUS" -ne 75 ]; then
  "$NODE" --no-warnings=ExperimentalWarning "$HERE/src/index.js" "$@" --regions=home --kind=fulltime ${PHASE_ARGS[@]+"${PHASE_ARGS[@]}"} >> "$LOG" 2>&1
  FT_STATUS=$?
  echo "$(date '+%Y-%m-%d %H:%M:%S') [EXIT fulltime $FT_STATUS]" >> "$LOG"
  if [ "$STATUS" -eq 0 ] && [ "$FT_STATUS" -ne 75 ]; then STATUS=$FT_STATUS; fi
fi
# A recovery that reached LinkedIn counts as tonight's; one stopped by a dead
# network (75) is tried again on the next tick of the same hour.
if [ "$SCAN_SLOT" = "recover" ] && [ "$STATUS" -ne 75 ]; then
  "$NODE" --no-warnings=ExperimentalWarning "$HERE/bin/recovery-slot.js" --done >> "$LOG" 2>&1 || true
fi
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') [EXIT $STATUS]" >> "$LOG"

# Is each live job still open? (bin/job-check.js, src/jobstatus.js) A slice of
# the due checks every tick — employer pages at least daily, jobs on the
# channels every few hours, LinkedIn's own pages at night — each recorded as a
# signal with a weight, the job's status and confidence decided from all of
# them. Capped at 4.5 minutes. It only marks rows; the NEXT scan's publish
# carries closes to the site, so this must never publish and race the scan.
# REPLACED bin/link-sweep.js --daily on 11 Oct 2026 (that one ran ~30 min once
# a day and is kept for a manual full pass). AFTER THE SCAN, as the sweep was
# since 1 Oct: run before it, it held the slot's publish back.
"$NODE" --no-warnings=ExperimentalWarning "$HERE/bin/job-check.js" >> "$LOG" 2>&1 || true

# Articles Distribb published to /api/distribb become blog posts here: images
# downloaded, blog/content/posts/<slug>.html written, the blog built and
# verified, committed by path and pushed (bin/distribb-import.js). AFTER the
# scan phases, never beside them: both commit in this checkout. Quick when the
# inbox has nothing new (one Redis read).
"$NODE" --no-warnings=ExperimentalWarning "$HERE/bin/distribb-import.js" >> "$LOG" 2>&1 || true

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

# Employer submissions from /post-a-job (web/api/post-job.js), asked every scan:
# a Mac banner and a phone push for any not seen before, silent otherwise.
# Approving is by hand (npm run submissions). Its exit status is discarded —
# a missing store or a dead network must never cost the scan anything.
"$NODE" --no-warnings=ExperimentalWarning "$HERE/bin/job-submissions.js" --notify >> "$LOG" 2>&1 || true

# The weekly data posts, same contract as the roundup: bin/datapost.js exits
# at once unless it is on or after the configured hour on the configured
# weekday and that week has not been written. Its exit status is discarded for
# the same reason the roundup's is.
"$NODE" --no-warnings=ExperimentalWarning "$HERE/bin/datapost.js" --no-open >> "$LOG" 2>&1 || true

# The daily digest, asked every scan and answered once a day.
#
# bin/digest.js exits immediately unless it is on or after the configured hour
# in the board's own zone and today's mail has not gone out, so this costs a
# process start 47 times a day and does real work once. Here rather than cron
# for the reason the roundup is: this Mac sleeps, and a job that fires at
# exactly 09:00 is simply missed.
#
# After publish, so every job page the mail links to is already on the site -
# and it reads web/public/.../jobs.json rather than the store, so a role publish
# held back is a role the mail never mentions.
#
# Status discarded like the roundup and the sweeps: a mail that could not be
# composed must never change how the scheduler treats the scan. It is also OFF
# in config.json until switched on deliberately.
"$NODE" --no-warnings=ExperimentalWarning "$HERE/bin/digest.js" >> "$LOG" 2>&1 || true

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

# The public GitHub internship list, asked every scan and answered once a day.
#
# bin/gh-readme.js exits immediately unless today's regeneration is outstanding,
# so this costs a process start 47 times a day and does real work once. Daily
# rather than per publish because that repo's history is PUBLIC: the README is
# deterministic and would usually be byte-identical, but asking 48 times a day
# is noise even when the answer is "nothing changed". It is also the only
# cadence that can always be met — the README says "Updated Daily" — because a
# fixed-time cron is simply missed while this Mac is asleep.
#
# After publish, so every job page the table links to is already on the site.
# Status discarded for the same reason as the roundup and the discovery sweep:
# a missing checkout, or a push that failed on a network blip, must never change
# how the scheduler treats the scan.
"$NODE" --no-warnings=ExperimentalWarning "$HERE/bin/gh-readme.js" --daily >> "$LOG" 2>&1 || true

exit $STATUS
