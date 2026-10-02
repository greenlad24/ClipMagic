#!/bin/bash
# UX Scout runner — picks up Scout jobs queued in the Lab and runs each one in
# Claude Code (the unmodified binary, signed in with Jake's own Max plan — no
# API key: ANTHROPIC_API_KEY/AUTH_TOKEN are removed from its environment).
# One job at a time. Cancel = the Lab sets cancelRequested; this loop kills the
# Claude Code process group and confirms with `scout stopped`.
set -u
BASE=/opt/clipmagic/scout-runner
WORK=$BASE/work
LOGS=$BASE/logs
SKILL=/root/.claude/skills/ux-scout
HOST_DATA=/var/lib/docker/volumes/clipmagic_clipmagic-lab-data/_data
MODEL=${SCOUT_MODEL:-claude-opus-5-5}
MAX_SECONDS=${SCOUT_MAX_SECONDS:-7200}
export PATH=/usr/local/bin:/root/.local/bin:/usr/bin:/bin

log() { echo "[$(date -u +%FT%TZ)] $*"; }

while true; do
  out=$(SCOUT_JOB= scout claim 2>/dev/null) || { sleep 30; continue; }
  id=$(echo "$out" | jq -r '.job.id // empty' 2>/dev/null)
  if [ -z "$id" ]; then sleep 15; continue; fi

  dir=$WORK/$id
  mkdir -p "$dir" "$LOGS"
  echo "$out" | jq '{goal: .job.goal, context: .job.context, tool: .tool, assets: .assets, runId: .job.runId}' > "$dir/job.json"
  log "job $id: $(jq -r '.tool.name + " — " + .goal' "$dir/job.json")"
  export SCOUT_JOB=$id

  prompt="Run the UX Scout for job $id. Your working directory holds job.json. Follow the UX Scout instructions in your system prompt exactly: read job.json and the business context first, drive the browser only with the scout command, narrate with scout note, keep key shots, write report.md here and finish with scout finish report.md --summary \"...\"."

  (
    cd "$dir" && exec setsid env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN SCOUT_JOB="$id" \
      timeout "$MAX_SECONDS" claude -p "$prompt" \
        --model "$MODEL" \
        --permission-mode dontAsk \
        --allowedTools "Bash(scout:*)" "Bash(scout *)" "Read" "Edit(./**)" \
        --add-dir "$HOST_DATA/scout/jobs/$id" "$SKILL" \
        --append-system-prompt "$(cat "$SKILL/SKILL.md")" \
        --output-format stream-json --verbose
  ) > "$LOGS/$id.jsonl" 2>&1 &
  pid=$!

  while kill -0 "$pid" 2>/dev/null; do
    st=$(scout status "$id" 2>/dev/null)
    if echo "$st" | jq -e '.cancelRequested == true' >/dev/null 2>&1; then
      log "job $id: cancel requested — stopping Claude Code"
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
      sleep 5; kill -KILL -- "-$pid" 2>/dev/null
      scout stopped "$id" >/dev/null 2>&1
      break
    fi
    sleep 10
  done
  wait "$pid" 2>/dev/null; rc=$?

  status=$(scout status "$id" 2>/dev/null | jq -r '.status // empty')
  if [ "$status" = "running" ]; then
    reason="Claude Code ended (exit $rc) without writing the report."
    [ "$rc" = "124" ] && reason="The Scout ran past $((MAX_SECONDS / 60)) minutes and was stopped."
    grep -q -i "usage limit\|rate limit\|limit reached" "$LOGS/$id.jsonl" 2>/dev/null && reason="$reason Your Max plan usage limit was reached — try again after it resets."
    scout fail "$reason" >/dev/null 2>&1
  fi
  log "job $id: finished ($status, exit $rc)"
  unset SCOUT_JOB
done
