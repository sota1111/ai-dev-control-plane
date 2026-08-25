#!/usr/bin/env bash
set -euo pipefail

# SOT-1753: discussion mode — two (or more) heterogeneous AI workers debate ONE topic over multiple
# rounds until they agree, or a moderator rules. This script is DISPATCHER-LAYER (a peer of
# scripts/ai/run_worker.sh): the round progression, convergence check, round cap, and fallback are all
# deterministic script logic; each utterance is one bounded worker-CLI call via the existing
# run_codex.sh / run_claude.sh / run_antigravity.sh with a `worker:model` pin — "AI does not call AI"
# is preserved because a participant never invokes another participant, this script sequences them.
#
# Usage:
#   scripts/ai/run_discussion.sh --topic "<question>" [--issue <id>] [--topic-file <path>] [--dry-run]
#
# Flow:
#   1. Append the topic to the shared thread docs/ai/discussion/<issue-id>.md.
#   2. Rounds 1..DISCUSSION_MAX_ROUNDS: each participant reads the thread and appends one utterance
#      (## Position / ## Rebuttal / ## Stance: AGREE|DISAGREE / ## Conclusion).
#   3. Convergence (script-side): all active participants say AGREE in the SAME round → consensus.
#   4. No consensus by the round cap → one moderator call (DISCUSSION_MODERATOR) issues `## Verdict`.
#   5. Result → docs/ai/pipeline/discussion_<issue-id>.md with a gate-compatible `## Next Action` line.
#
# Participant failure (usage limit exit 75 / crash / invalid utterance after one retry) = non-
# convergence for that worker: it is dropped and the discussion falls back to the remaining
# participants, then to the moderator. Only when the moderator ALSO fails does this script exit 75
# (same "transiently non-responsive, retry later" contract as run_worker.sh).
#
# Env:
#   DISCUSSION_PARTICIPANTS   `+`-joined worker[:model] list (default: codex:sol+claude:fable)
#   DISCUSSION_MAX_ROUNDS     round cap (default: 3)
#   DISCUSSION_MODERATOR      moderator worker[:model] (default: claude:fable)
#   DISCUSSION_TOPIC          topic text (--topic/--topic-file win)
#   DISCUSSION_LANE           RUNNER_LANE for the worker calls (default: discussion) so prompt/report/
#                             session files never collide with a concurrently running pipeline lane
#   DISCUSSION_SESSION_REUSE  worker session reuse for utterances (default: 0 — each utterance is
#                             hermetic; the full thread is in the prompt, and codex `resume --last`
#                             could otherwise attach to an unrelated concurrent session)
#   DISCUSSION_SCRIPT_DIR     dir of the worker run scripts (default: this dir; test stubs override)
#   DISCUSSION_THREAD_DIR     thread dir (default: docs/ai/discussion)
#   DISCUSSION_OUT_DIR        result dir (default: docs/ai/pipeline)
#   CODEX_HARNESS_SPEC        default 0 here (the participant prompt is self-contained; the ~35KB
#                             CLAUDE.md injection per utterance is pure token cost) — export 1 to keep

CONTROL_PLANE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

WORKER_NONRESPONSE_EXIT=75

ISSUE_ID=""
TOPIC="${DISCUSSION_TOPIC:-}"
DRY_RUN=false
while [ $# -gt 0 ]; do
  case "$1" in
    --issue) ISSUE_ID="${2:-}"; shift 2 ;;
    --topic) TOPIC="${2:-}"; shift 2 ;;
    --topic-file)
      if [ ! -f "${2:-}" ]; then echo "run_discussion.sh: topic file not found: ${2:-}" >&2; exit 2; fi
      TOPIC="$(cat "$2")"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    *) echo "run_discussion.sh: unknown arg $1" >&2; exit 2 ;;
  esac
done

# Issue id: flag > injected env > pipeline context > adhoc. Sanitized so it is filename-safe.
if [ -z "$ISSUE_ID" ]; then ISSUE_ID="${WEBHOOK_ISSUE_ID:-}"; fi
_DISC_CTX="${PIPELINE_CONTEXT_JSON_FILE:-${PIPELINE_CONTEXT_FILE:-}}"
if [ -z "$ISSUE_ID" ] && [ -f "$_DISC_CTX" ]; then
  ISSUE_ID="$(node -e 'const c=require(process.argv[1]);process.stdout.write(c.issue?.identifier||"")' "$_DISC_CTX" 2>/dev/null || true)"
fi
ISSUE_ID="$(printf '%s' "${ISSUE_ID:-adhoc}" | tr -cd 'a-zA-Z0-9._-')"
[ -z "$ISSUE_ID" ] && ISSUE_ID="adhoc"

MAX_ROUNDS="${DISCUSSION_MAX_ROUNDS:-3}"
case "$MAX_ROUNDS" in ''|*[!0-9]*) echo "run_discussion.sh: DISCUSSION_MAX_ROUNDS must be a positive integer (got '$MAX_ROUNDS')" >&2; exit 2 ;; esac
[ "$MAX_ROUNDS" -ge 1 ] || { echo "run_discussion.sh: DISCUSSION_MAX_ROUNDS must be >= 1" >&2; exit 2; }

PARTICIPANTS_SPEC="${DISCUSSION_PARTICIPANTS:-codex:sol+claude:fable}"
MODERATOR_SPEC="${DISCUSSION_MODERATOR:-claude:fable}"
DISCUSSION_LANE="$(printf '%s' "${DISCUSSION_LANE:-discussion}" | tr -cd 'a-zA-Z0-9_-')"
[ -z "$DISCUSSION_LANE" ] && DISCUSSION_LANE="discussion"
SCRIPT_DIR="${DISCUSSION_SCRIPT_DIR:-$CONTROL_PLANE_DIR/scripts/ai}"
THREAD_DIR="${DISCUSSION_THREAD_DIR:-$CONTROL_PLANE_DIR/docs/ai/discussion}"
OUT_DIR="${DISCUSSION_OUT_DIR:-$CONTROL_PLANE_DIR/docs/ai/pipeline}"
THREAD_FILE="$THREAD_DIR/$ISSUE_ID.md"
OUT_FILE="$OUT_DIR/discussion_$ISSUE_ID.md"
ROLE_PROMPT="$CONTROL_PLANE_DIR/prompts/roles/discussion.md"

# `worker[:model]` token → WORKER / MODEL / LABEL globals (same first-colon model split as the
# directive parser src/lib/workerRoleDirective.ts, its unit-tested reference spec).
parse_token() {
  local token="$1"
  case "$token" in
    *:*) WORKER="${token%%:*}"; MODEL="${token#*:}" ;;
    *)   WORKER="$token"; MODEL="" ;;
  esac
  WORKER="$(printf '%s' "$WORKER" | tr '[:upper:]' '[:lower:]')"
  [ "$WORKER" = "agy" ] && WORKER="antigravity"
  case "$WORKER" in
    claude|codex|antigravity) ;;
    *) echo "run_discussion.sh: unknown worker '$WORKER' in token '$token' (valid: claude, codex, antigravity/agy)" >&2; exit 2 ;;
  esac
  LABEL="$WORKER${MODEL:+:$MODEL}"
}

# Ordered participant arrays (index-aligned): parse the `+`-joined spec.
P_WORKERS=() P_MODELS=() P_LABELS=() P_ACTIVE=() P_STANCE=()
IFS='+' read -r -a _TOKENS <<< "$PARTICIPANTS_SPEC"
for _t in "${_TOKENS[@]}"; do
  _t="$(printf '%s' "$_t" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [ -z "$_t" ] && continue
  parse_token "$_t"
  P_WORKERS+=("$WORKER"); P_MODELS+=("$MODEL"); P_LABELS+=("$LABEL"); P_ACTIVE+=(1); P_STANCE+=("")
done
N_PARTICIPANTS="${#P_WORKERS[@]}"
if [ "$N_PARTICIPANTS" -lt 2 ]; then
  echo "run_discussion.sh: need at least 2 participants (got '$PARTICIPANTS_SPEC')" >&2
  exit 2
fi
parse_token "$MODERATOR_SPEC"
MOD_WORKER="$WORKER"; MOD_MODEL="$MODEL"; MOD_LABEL="$LABEL"

if [ -z "$TOPIC" ]; then
  echo "run_discussion.sh: no topic (use --topic / --topic-file / DISCUSSION_TOPIC)" >&2
  exit 2
fi

PARTICIPANT_LIST=""
for _l in "${P_LABELS[@]}"; do PARTICIPANT_LIST="${PARTICIPANT_LIST:+$PARTICIPANT_LIST, }$_l"; done

if [ "$DRY_RUN" = true ]; then
  echo "DRY_RUN discussion issue=$ISSUE_ID participants=[$PARTICIPANT_LIST] max_rounds=$MAX_ROUNDS moderator=$MOD_LABEL"
  echo "DRY_RUN thread=$THREAD_FILE out=$OUT_FILE lane=$DISCUSSION_LANE scripts=$SCRIPT_DIR"
  exit 0
fi

mkdir -p "$THREAD_DIR" "$OUT_DIR"

# Mirror the worker run scripts' lane-aware paths (RUNNER_LANE=$DISCUSSION_LANE for every call).
lane_path() {
  local p="$1" dir base name ext
  dir="$(dirname "$p")"; base="$(basename "$p")"; ext="${base##*.}"; name="${base%.*}"
  printf '%s/%s.%s.%s' "$dir" "$name" "$DISCUSSION_LANE" "$ext"
}
worker_script() {
  case "$1" in
    codex)       printf '%s' "$SCRIPT_DIR/run_codex.sh" ;;
    claude)      printf '%s' "$SCRIPT_DIR/run_claude.sh" ;;
    antigravity) printf '%s' "$SCRIPT_DIR/run_antigravity.sh" ;;
  esac
}
worker_prompt_file() {
  case "$1" in
    codex)       lane_path "$CONTROL_PLANE_DIR/prompts/codex/debug.md" ;;
    claude)      lane_path "$CONTROL_PLANE_DIR/prompts/claude/worker.md" ;;
    antigravity) lane_path "$CONTROL_PLANE_DIR/prompts/antigravity/implement.md" ;;
  esac
}
worker_report_file() {
  case "$1" in
    codex)       lane_path "$CONTROL_PLANE_DIR/docs/ai/60_worker_codex_report.md" ;;
    claude)      lane_path "$CONTROL_PLANE_DIR/docs/ai/55_worker_claude_report.md" ;;
    antigravity) lane_path "$CONTROL_PLANE_DIR/docs/ai/50_worker_antigravity_report.md" ;;
  esac
}

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# One worker call. Args: worker model prompt_content. Sets UTTER_REPORT to the report path; returns
# the run script's exit code. Every call is dispatched exactly like run_worker.sh does it (env
# RUN_WORKER_DISPATCH=1 + model env var), on the dedicated discussion lane.
invoke_worker() {
  local worker="$1" model="$2" prompt="$3"
  local script prompt_file
  script="$(worker_script "$worker")"
  prompt_file="$(worker_prompt_file "$worker")"
  UTTER_REPORT="$(worker_report_file "$worker")"
  mkdir -p "$(dirname "$prompt_file")"
  printf '%s' "$prompt" > "$prompt_file"
  rm -f "$UTTER_REPORT"

  local model_env=()
  if [ -n "$model" ]; then
    case "$worker" in
      codex)       model_env=(CODEX_MODEL="$model") ;;
      claude)      model_env=(CLAUDE_MODEL="$model") ;;
      antigravity) model_env=(AGY_MODEL="$model") ;;
    esac
  fi

  # `|| rc=$?` (not set +e/-e): `set -e` is process-global, so re-enabling it inside this function
  # would make our own non-zero `return` fatal to a caller that had errexit suspended.
  local rc=0
  env RUN_WORKER_DISPATCH=1 WORKER_ROLE=discussion WORKER_SELECTED="$worker" \
    RUNNER_LANE="$DISCUSSION_LANE" \
    WORKER_SESSION_REUSE="${DISCUSSION_SESSION_REUSE:-0}" \
    CODEX_HARNESS_SPEC="${CODEX_HARNESS_SPEC:-0}" \
    DISCUSSION_PROMPT_FILE="$prompt_file" DISCUSSION_REPORT_FILE="$UTTER_REPORT" \
    DISCUSSION_ROUND="${DISCUSSION_ROUND_NO:-}" \
    "${model_env[@]}" \
    bash "$script" || rc=$?
  return "$rc"
}

# Extract the utterance body from a worker report: from the LAST anchor header ("## Position" for
# participants, "## Verdict" for the moderator) up to — not including — the next "## Next Action"
# report-contract line. Anchoring on the LAST occurrence matters: the codex CLI echoes the prompt
# (which quotes these headers in the format template and the thread) into its transcript before the
# final message, so the first occurrence can sit inside the echo — the real utterance comes last.
extract_section() {
  local file="$1" anchor="$2"
  awk -v a="^##[[:space:]]*$anchor" '
    $0 ~ a {f=1; buf=""}
    f {
      if ($0 ~ /^##[[:space:]]*Next Action/) { f=0; next }
      buf = buf $0 "\n"
    }
    END { printf "%s", buf }
  ' "$file"
}

# Participant utterance with one bounded retry (fallback policy: retry a non-responsive worker AT MOST
# once; a usage-limit 75 is NOT retried — its cooldown is already set, an immediate retry only re-hits
# it). Sets UTTERANCE and STANCE on success. Returns non-zero when the participant must be dropped.
participant_utterance() {
  local worker="$1" model="$2" prompt="$3" attempt rc
  for attempt in 1 2; do
    rc=0
    invoke_worker "$worker" "$model" "$prompt" || rc=$?
    if [ "$rc" -eq "$WORKER_NONRESPONSE_EXIT" ]; then
      echo "DISCUSSION_PARTICIPANT_UNAVAILABLE worker=$worker rc=$rc (usage limit / non-response)" >&2
      return 1
    fi
    if [ "$rc" -eq 0 ] && [ -f "$UTTER_REPORT" ]; then
      UTTERANCE="$(extract_section "$UTTER_REPORT" "Position")"
      STANCE="$(printf '%s\n' "$UTTERANCE" | grep -iE '^##[[:space:]]*Stance:' | tail -1 | grep -oiE 'DISAGREE|AGREE' | head -1 | tr '[:lower:]' '[:upper:]' || true)"
      if [ -n "$UTTERANCE" ] && [ -n "$STANCE" ]; then
        return 0
      fi
      echo "DISCUSSION_INVALID_UTTERANCE worker=$worker attempt=$attempt (missing ## Position / ## Stance)" >&2
    else
      echo "DISCUSSION_PARTICIPANT_ERROR worker=$worker rc=$rc attempt=$attempt" >&2
    fi
  done
  return 1
}

# ── Thread setup ────────────────────────────────────────────────────────────────────────────────────
if [ ! -f "$THREAD_FILE" ]; then
  {
    echo "# Discussion Thread: $ISSUE_ID"
    echo
    echo "- Created: $(now_utc)"
    echo "- Participants: $PARTICIPANT_LIST"
    echo "- Max rounds: $MAX_ROUNDS"
    echo
    echo "## Topic"
    echo
    printf '%s\n' "$TOPIC"
  } > "$THREAD_FILE"
else
  # Re-run on the same issue: keep the history, mark a fresh session, restate the topic.
  {
    echo
    echo "---"
    echo
    echo "## Session $(now_utc) (participants: $PARTICIPANT_LIST, max rounds: $MAX_ROUNDS)"
    echo
    echo "## Topic"
    echo
    printf '%s\n' "$TOPIC"
  } >> "$THREAD_FILE"
fi

echo "== Discussion: issue=$ISSUE_ID participants=[$PARTICIPANT_LIST] max_rounds=$MAX_ROUNDS moderator=$MOD_LABEL =="

# ── Rounds ──────────────────────────────────────────────────────────────────────────────────────────
OUTCOME=""            # CONSENSUS | VERDICT | EXHAUSTED
CONSENSUS_ROUND=""
ROUNDS_DONE=0
DROPPED=""

active_count() {
  local n=0 i
  for i in $(seq 0 $((N_PARTICIPANTS - 1))); do [ "${P_ACTIVE[$i]}" = "1" ] && n=$((n + 1)); done
  echo "$n"
}

for ROUND in $(seq 1 "$MAX_ROUNDS"); do
  if [ "$(active_count)" -lt 2 ]; then
    break # fewer than 2 voices left — no consensus possible, fall through to the moderator
  fi
  ROUNDS_DONE="$ROUND"
  DISCUSSION_ROUND_NO="$ROUND"
  echo "-- round $ROUND/$MAX_ROUNDS --"

  for i in $(seq 0 $((N_PARTICIPANTS - 1))); do
    [ "${P_ACTIVE[$i]}" = "1" ] || continue
    worker="${P_WORKERS[$i]}"; model="${P_MODELS[$i]}"; label="${P_LABELS[$i]}"
    others=""
    for j in $(seq 0 $((N_PARTICIPANTS - 1))); do
      [ "$j" -ne "$i" ] && [ "${P_ACTIVE[$j]}" = "1" ] && others="${others:+$others, }${P_LABELS[$j]}"
    done

    prompt="$(cat "$ROLE_PROMPT")

---

## Discussion Context
- Issue: $ISSUE_ID
- Round: $ROUND of $MAX_ROUNDS
- You are participant: $label
- Other participant(s): ${others:-none}
- If ALL participants output Stance: AGREE in this round, the discussion ends in consensus. If round
  $MAX_ROUNDS ends without consensus, a moderator issues a binding verdict.

## Thread so far

$(cat "$THREAD_FILE")"

    if participant_utterance "$worker" "$model" "$prompt"; then
      {
        echo
        echo "## Round $ROUND — $label ($(now_utc))"
        echo
        printf '%s\n' "$UTTERANCE"
      } >> "$THREAD_FILE"
      P_STANCE[$i]="$STANCE"
      echo "DISCUSSION_UTTERANCE round=$ROUND participant=$label stance=$STANCE"
    else
      P_ACTIVE[$i]=0
      P_STANCE[$i]=""
      DROPPED="${DROPPED:+$DROPPED, }$label"
      {
        echo
        echo "## Round $ROUND — $label ($(now_utc))"
        echo
        echo "_(no response — participant dropped: usage limit or invalid output)_"
      } >> "$THREAD_FILE"
      echo "DISCUSSION_DROPPED round=$ROUND participant=$label"
    fi
  done

  # Convergence check (script-side): every ACTIVE participant said AGREE in THIS round.
  if [ "$(active_count)" -ge 2 ]; then
    all_agree=1
    for i in $(seq 0 $((N_PARTICIPANTS - 1))); do
      [ "${P_ACTIVE[$i]}" = "1" ] || continue
      [ "${P_STANCE[$i]}" = "AGREE" ] || { all_agree=0; break; }
    done
    if [ "$all_agree" -eq 1 ]; then
      OUTCOME="CONSENSUS"
      CONSENSUS_ROUND="$ROUND"
      echo "DISCUSSION_CONSENSUS round=$ROUND"
      break
    fi
  fi
done

# ── Moderator verdict (no consensus) ───────────────────────────────────────────────────────────────
VERDICT_TEXT=""
if [ -z "$OUTCOME" ]; then
  echo "-- no consensus after $ROUNDS_DONE round(s): moderator $MOD_LABEL rules --"
  DISCUSSION_ROUND_NO="moderator"
  mod_prompt="# Role: discussion moderator (裁定者)

A structured multi-round AI discussion did not converge within its round limit. You are the MODERATOR.
Read the whole thread below and issue ONE binding verdict on the topic: pick the stronger position or
synthesize both into a single definitive answer. Judge only from the thread (plus read-only repository
checks if needed); do not edit files or run anything destructive. You do NOT interact with the human.

## Output format (EXACT — the script parses these headers)

## Verdict
<the single binding answer, self-contained, with 1–3 sentences of reasoning>

## Next Action: READY_FOR_REVIEW

## Thread

$(cat "$THREAD_FILE")"

  mod_ok=0
  for attempt in 1 2; do
    rc=0
    invoke_worker "$MOD_WORKER" "$MOD_MODEL" "$mod_prompt" || rc=$?
    if [ "$rc" -eq 0 ] && [ -f "$UTTER_REPORT" ]; then
      VERDICT_TEXT="$(extract_section "$UTTER_REPORT" "Verdict")"
      if [ -n "$VERDICT_TEXT" ]; then mod_ok=1; break; fi
      echo "DISCUSSION_INVALID_VERDICT attempt=$attempt (missing ## Verdict)" >&2
    else
      echo "DISCUSSION_MODERATOR_ERROR rc=$rc attempt=$attempt" >&2
      if [ "$rc" -eq "$WORKER_NONRESPONSE_EXIT" ]; then break; fi # cooldown set — a retry re-hits it
    fi
  done
  if [ "$mod_ok" -eq 1 ]; then
    OUTCOME="VERDICT"
    {
      echo
      echo "## Moderator — $MOD_LABEL ($(now_utc))"
      echo
      printf '%s\n' "$VERDICT_TEXT"
    } >> "$THREAD_FILE"
  else
    OUTCOME="EXHAUSTED"
  fi
fi

# ── Result report (gate-compatible ## Next Action) ─────────────────────────────────────────────────
TOPIC_LINE="$(printf '%s' "$TOPIC" | head -1)"
{
  echo "# Discussion Report: $ISSUE_ID"
  echo
  echo "- Topic: $TOPIC_LINE"
  echo "- Participants: $PARTICIPANT_LIST"
  echo "- Rounds completed: $ROUNDS_DONE / max $MAX_ROUNDS"
  case "$OUTCOME" in
    CONSENSUS) echo "- Outcome: CONSENSUS (all participants AGREE in round $CONSENSUS_ROUND)" ;;
    VERDICT)   echo "- Outcome: VERDICT (moderator $MOD_LABEL ruled after no consensus)" ;;
    EXHAUSTED) echo "- Outcome: EXHAUSTED (no consensus and the moderator was unavailable)" ;;
  esac
  [ -n "$DROPPED" ] && echo "- Dropped participants: $DROPPED"
  echo "- Thread: $THREAD_FILE"
  echo
  if [ "$OUTCOME" = "CONSENSUS" ]; then
    echo "## Consensus"
    echo
    echo "Agreed conclusions from round $CONSENSUS_ROUND:"
    for i in $(seq 0 $((N_PARTICIPANTS - 1))); do
      [ "${P_ACTIVE[$i]}" = "1" ] || continue
      echo
      echo "### ${P_LABELS[$i]}"
      echo
      # Last "## Conclusion" this participant wrote in the thread (their agreed answer). Literal
      # index() matching, not regex — labels may carry model ids with regex metacharacters.
      awk -v lbl="${P_LABELS[$i]}" '
        /^## / {
          conc = 0
          if (index($0, "## Round ") == 1 && index($0, " — " lbl " (") > 0) { inround = 1 }
          else if (index($0, "## Conclusion") == 1 && inround) { conc = 1; buf = "" }
          else if (index($0, "## Round ") == 1 || index($0, "## Moderator ") == 1 || index($0, "## Session ") == 1) { inround = 0 }
          next
        }
        conc { buf = buf $0 "\n" }
        END { printf "%s", buf }
      ' "$THREAD_FILE"
    done
  elif [ "$OUTCOME" = "VERDICT" ]; then
    echo "## Verdict"
    printf '%s\n' "$VERDICT_TEXT" | sed '1{/^##[[:space:]]*Verdict/d}'
  else
    echo "## Result"
    echo
    echo "The discussion could not be concluded: participants and/or the moderator were unavailable"
    echo "(usage limit or repeated invalid output). Re-run when a worker recovers."
  fi
  echo
  if [ "$OUTCOME" = "EXHAUSTED" ]; then
    echo "## Next Action: BLOCKED"
  else
    echo "## Next Action: READY_FOR_REVIEW"
  fi
} > "$OUT_FILE"

echo "DISCUSSION_DONE issue=$ISSUE_ID outcome=$OUTCOME rounds=$ROUNDS_DONE report=$OUT_FILE thread=$THREAD_FILE"
if [ "$OUTCOME" = "EXHAUSTED" ]; then
  exit "$WORKER_NONRESPONSE_EXIT"
fi
exit 0
