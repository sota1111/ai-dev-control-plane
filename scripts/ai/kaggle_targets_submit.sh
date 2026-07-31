#!/usr/bin/env bash
# SOT-1913 / SOT-1934: 「取り組み完了時に提出」— マルチコンペ artifact 提出。
#
# SOT-1904 の単一コンペ専用・直近2提出収束ロジック（kaggle_auto_submit.sh / runner-cli kaggle-plan）は
# **この経路では使わない**。提出対象は registry の submit が指す検証済みartifactで、champion昇格は不要。別
# スケジュールの提出 cron は持たず、当番コンペの取り組み完了時にこのスクリプトを呼んで提出する
# （1枠=1コンペ一巡で各コンペ1日1提出が自然に成立）。翌日の同じコンペ枠での前回結果確認は起案側
# （SOT-1932 の材料収集）で行う。
#
# 動作:
#   (1) --competition <key>（または --hour から rotation で解決）でコンペを決める。
#   (2) その Kaggle slug の提出履歴を取得し、各ターゲット(repo)の当日提出数を数える（冪等判定用）。
#   (3) runner-cli kaggle-submission-plan で各ターゲットの提出プランを得る。
#   (4) --execute 指定時のみ、action=submit の candidate/champion artifact を Kaggle へ提出する。
#       submit.file 未設定（提出物未整備）は skip + 通知で安全側。当日すでに提出済みなら二重提出しない。
#
# 使い方:
#   bash scripts/ai/kaggle_targets_submit.sh --competition ptcg              # ドライラン（プラン表示）
#   bash scripts/ai/kaggle_targets_submit.sh --hour 0 --execute             # 当番コンペを実提出
#
# 既定はドライラン。実提出は --execute（Kaggle 認証が要る）。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

REGISTRY="$SCRIPT_DIR/kaggle_targets_registry.json"
EXECUTE=0
COMP_KEY=""
HOUR_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1 ;;
    --competition) COMP_KEY="$2"; shift ;;
    --competition=*) COMP_KEY="${1#*=}" ;;
    --hour) HOUR_OVERRIDE="$2"; shift ;;
    --hour=*) HOUR_OVERRIDE="${1#*=}" ;;
    --registry) REGISTRY="$2"; shift ;;
    --registry=*) REGISTRY="${1#*=}" ;;
    -h|--help) sed -n '2,28p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ ! -f "$REGISTRY" ]]; then
  echo "ERROR: targets registry not found: $REGISTRY" >&2
  exit 2
fi

HOUR="${HOUR_OVERRIDE:-$(TZ=Asia/Tokyo date +%-H)}"

# コンペ key を解決（--competition 優先、無ければ --hour の rotation）。
if [[ -z "$COMP_KEY" ]]; then
  COMP_KEY="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const h=Number(process.argv[2]);const e=(r.rotation||[]).find(x=>x.hour_jst===h);process.stdout.write(e?e.competition:"")' "$REGISTRY" "$HOUR")"
fi
if [[ -z "$COMP_KEY" ]]; then
  echo "skip: JST hour ${HOUR} に当番コンペがありません（--competition で明示指定してください）。"
  exit 0
fi

# コンペの Kaggle slug と repo 一覧を registry から読む。
COMP_SLUG="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=(r.competitions||[]).find(x=>x.key===process.argv[2]);process.stdout.write(c?c.kaggle_competition:"")' "$REGISTRY" "$COMP_KEY")"
if [[ -z "$COMP_SLUG" ]]; then echo "ERROR: competition '$COMP_KEY' が registry にありません。" >&2; exit 2; fi
mapfile -t REPOS < <(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=(r.competitions||[]).find(x=>x.key===process.argv[2]);(c?c.targets:[]).forEach(t=>console.log(t.repo))' "$REGISTRY" "$COMP_KEY")

# このコンペの提出モード（both / alternate）。alternate(ARC=1/day 共有)は日替わりで交互提出する。
SUBMISSION_MODE="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=(r.competitions||[]).find(x=>x.key===process.argv[2]);process.stdout.write(c&&c.submission_mode?c.submission_mode:"both")' "$REGISTRY" "$COMP_KEY")"

# 各 repo の当日提出数を数える（Kaggle 履歴の description に repo 名が入る前提）。
# 併せて alternate モード用に「最後に提出した repo（＝系統）」を Kaggle 履歴の最新行から拾う。
today_utc="$(date -u +%F)"
slot_id="${today_utc}-jst-$(printf '%02d' "$HOUR")"
declare -A today_count
declare -A current_fingerprint
declare -A submitted_fingerprints
for repo in "${REPOS[@]}"; do today_count["$repo"]=0; done
for repo in "${REPOS[@]}"; do
  submit_file="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=(r.competitions||[]).find(x=>x.key===process.argv[2]);const t=(c?c.targets:[]).find(x=>x.repo===process.argv[3]);process.stdout.write(t&&t.submit&&t.submit.file||"")' "$REGISTRY" "$COMP_KEY" "$repo")"
  if [[ -n "$submit_file" && -f "$submit_file" ]]; then
    current_fingerprint["$repo"]="sha256:$(sha256sum "$submit_file" | awk '{print $1}')"
  else
    current_fingerprint["$repo"]=""
  fi
  submitted_fingerprints["$repo"]=""
done
LAST_REPO=""
HISTORY_OK=0
HISTORY_REASON=""
raw=""
completed_slot_repos=()
TOTAL_TODAY=0

if ! command -v kaggle >/dev/null 2>&1; then
  HISTORY_REASON="Kaggle CLI is not installed"
elif raw="$(kaggle competitions submissions -c "$COMP_SLUG" 2>&1)"; then
  HISTORY_OK=1
  if [[ -n "$raw" ]]; then
    while IFS= read -r line; do
      [[ -z "${line// }" ]] && continue
      # Kaggle は最新提出を先頭に列挙する。最初にマッチした repo を「前回提出系統」とする。
      if [[ -z "$LAST_REPO" ]]; then
        for repo in "${REPOS[@]}"; do
          if grep -q "$repo" <<<"$line"; then LAST_REPO="$repo"; break; fi
        done
      fi
      # Failed submissions do not consume a usable daily lineage slot. Permit a
      # corrected artifact to retry while still deduplicating PENDING/COMPLETE.
      grep -qE 'SubmissionStatus\.(ERROR|CANCELLED)' <<<"$line" && continue
      d="$(grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' <<<"$line" | head -1)"
      [[ "$d" == "$today_utc" ]] || continue
      TOTAL_TODAY=$((TOTAL_TODAY + 1))
      for repo in "${REPOS[@]}"; do
        if grep -Fq "$repo" <<<"$line"; then
          today_count["$repo"]=$(( ${today_count["$repo"]} + 1 ))
          line_fingerprint="$(grep -oE '\\[artifact:sha256:[0-9a-f]{64}\\]' <<<"$line" | head -1 | sed -E 's/^\\[artifact:|\\]$//g')"
          if [[ -n "$line_fingerprint" ]]; then
            submitted_fingerprints["$repo"]+="${line_fingerprint}"$'\n'
          fi
          if grep -Fq "[slot:${slot_id}]" <<<"$line"; then
            completed_slot_repos+=("$repo")
          fi
        fi
      done
    done < <(printf '%s\n' "$raw" | tail -n +3)
  fi
else
  HISTORY_REASON="$(printf '%s' "$raw" | tr '\n' ' ' | cut -c1-300)"
fi

previous_results_json="$(printf '%s\n' "$raw" | node -e '
  const input=require("fs").readFileSync(0,"utf8").split(/\r?\n/).filter(Boolean);
  const rows=input.slice(2,5).map(line=>{
    const fields=line.trim().split(/\s{2,}|\t+/);
    return {
      submission_ref: fields[0] || null,
      status: fields.find(v=>/^(complete|pending|error|cancelled|SubmissionStatus\.)/i.test(v)) || null,
      public_score: [...fields].reverse().find(v=>/^-?\d+(?:\.\d+)?$/.test(v)) || null,
      raw: line.slice(0,500)
    };
  });
  process.stdout.write(JSON.stringify(rows));
')"

# LAST_REPO → 系統（claude/gpt）。registry の targets から引く。空なら --last-lineage は付けない
# （engine 側で claude 始まりの交互になる）。
LAST_LINEAGE=""
if [[ -n "$LAST_REPO" ]]; then
  LAST_LINEAGE="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=(r.competitions||[]).find(x=>x.key===process.argv[2]);const t=(c?c.targets:[]).find(x=>x.repo===process.argv[3]);process.stdout.write(t?t.lineage:"")' "$REGISTRY" "$COMP_KEY" "$LAST_REPO")"
fi

# submittedByRepo JSON（repo→当日提出数）を組む。
submitted_json="{"
first=1
for repo in "${REPOS[@]}"; do
  [[ $first == 1 ]] || submitted_json+=","
  submitted_json+="\"$repo\":${today_count[$repo]}"
  first=0
done
submitted_json+="}"
completed_slot_json="$(printf '%s\n' "${completed_slot_repos[@]}" | node -e '
  const values=require("fs").readFileSync(0,"utf8").split(/\r?\n/).filter(Boolean);
  process.stdout.write(JSON.stringify([...new Set(values)]));
')"
artifact_fingerprints_json="$(
  for repo in "${REPOS[@]}"; do printf '%s\t%s\n' "$repo" "${current_fingerprint[$repo]}"; done |
    node -e 'const rows=require("fs").readFileSync(0,"utf8").trim().split(/\r?\n/).filter(Boolean);const out={};for(const row of rows){const [repo,fp]=row.split("\t");if(fp)out[repo]=fp;}process.stdout.write(JSON.stringify(out));'
)"
submitted_artifact_fingerprints_json="$(
  for repo in "${REPOS[@]}"; do
    while IFS= read -r fp; do [[ -n "$fp" ]] && printf '%s\t%s\n' "$repo" "$fp"; done <<<"${submitted_fingerprints[$repo]}"
  done | node -e 'const rows=require("fs").readFileSync(0,"utf8").trim().split(/\r?\n/).filter(Boolean);const out={};for(const row of rows){const [repo,fp]=row.split("\t");(out[repo]??=[]).push(fp);}process.stdout.write(JSON.stringify(out));'
)"

# alternate モードのときだけ --last-lineage を付ける（both では engine が無視する）。
LINEAGE_ARGS=()
if [[ "$SUBMISSION_MODE" == "alternate" && -n "$LAST_LINEAGE" ]]; then
  LINEAGE_ARGS=(--last-lineage "$LAST_LINEAGE")
fi

# 提出プランを得る（candidate/champion 共通）。
plan_json="$(cd "$REPO_ROOT" && npx --no-install tsx src/runner-cli.ts kaggle-submission-plan \
  --registry "$REGISTRY" --competition "$COMP_KEY" --submitted "$submitted_json" \
  --date-utc "$today_utc" --completed-slot-repos "$completed_slot_json" \
  --competition-submitted "$TOTAL_TODAY" \
  --artifact-fingerprints "$artifact_fingerprints_json" \
  --submitted-artifact-fingerprints "$submitted_artifact_fingerprints_json" \
  "${LINEAGE_ARGS[@]}" 2>/dev/null)"
if [[ -z "$plan_json" ]]; then
  plan_json="$(cd "$REPO_ROOT" && npx tsx src/runner-cli.ts kaggle-submission-plan \
    --registry "$REGISTRY" --competition "$COMP_KEY" --submitted "$submitted_json" \
    --date-utc "$today_utc" --completed-slot-repos "$completed_slot_json" \
    --competition-submitted "$TOTAL_TODAY" \
    --artifact-fingerprints "$artifact_fingerprints_json" \
    --submitted-artifact-fingerprints "$submitted_artifact_fingerprints_json" \
    "${LINEAGE_ARGS[@]}" 2>/dev/null)"
fi
if [[ -z "$plan_json" ]]; then
  echo "ERROR: kaggle-submission-plan の実行に失敗しました（tsx/runner-cli を確認）。" >&2
  exit 2
fi

echo "== Kaggle 完了トリガ提出 ($COMP_KEY / $COMP_SLUG, slot=$slot_id) =="
if [[ "$HISTORY_OK" != "1" ]]; then
  echo "  measurement unavailable: $HISTORY_REASON"
fi
node -e '
  const o=JSON.parse(process.argv[1]||"{}");
  const mode=o.mode||"both";
  console.log(`  mode=${mode}` + (o.chosenLineage?` chosen=${o.chosenLineage} (alternate)`:""));
  for(const t of (o.targets||[])){
    console.log(`  ${t.repo} [${t.lineage}] → ${t.action}  (${t.reason})`);
  }
' "$plan_json"

# 記録（append-only jsonl）。
HIST_FILE="${KAGGLE_SUBMISSION_HISTORY:-$REPO_ROOT/docs/ai/kaggle/submission-history.jsonl}"
HIST_DIR="$(dirname "$HIST_FILE")"; mkdir -p "$HIST_DIR"
ts="$(date -u +%FT%TZ)"
node -e '
  const fs=require("fs");
  const [, file, ts, plan, mode, slot, historyOk, reason, previous] = process.argv;
  fs.appendFileSync(file, JSON.stringify({
    ts, source:"kaggle_targets_submit", mode, slot,
    history:{ ok:historyOk==="1", reason:reason||null, previous_results:JSON.parse(previous||"[]") },
    plan:JSON.parse(plan||"{}")
  })+"\n");
' "$HIST_FILE" "$ts" "$plan_json" "$([[ $EXECUTE == 1 ]] && echo execute || echo dry-run)" \
  "$slot_id" "$HISTORY_OK" "$HISTORY_REASON" "$previous_results_json"

if [[ "$EXECUTE" != "1" ]]; then
  echo "  → ドライラン。実提出するには --execute を付けてください。"
  exit 0
fi

if [[ "$HISTORY_OK" != "1" ]]; then
  echo "  → SAFE SKIP: 前回提出status/public score/submission refを取得できないため提出しません。" >&2
  bash "$SCRIPT_DIR/notify_discord.sh" \
    "kaggle提出 safe skip $COMP_KEY slot=$slot_id: 前回結果取得失敗 ($HISTORY_REASON)" \
    >/dev/null 2>&1 || true
  exit 0
fi

# --execute: action=submit のターゲットを提出。skip は通知のみ。
rc_all=0
n_targets="$(node -e 'process.stdout.write(String((JSON.parse(process.argv[1]||"{}").targets||[]).length))' "$plan_json")"
for ((i=0; i<n_targets; i++)); do
  action="$(node -e 'process.stdout.write((JSON.parse(process.argv[1]).targets[Number(process.argv[2])].action)||"")' "$plan_json" "$i")"
  repo="$(node -e 'process.stdout.write((JSON.parse(process.argv[1]).targets[Number(process.argv[2])].repo)||"")' "$plan_json" "$i")"
  if [[ "$action" != "submit" ]]; then
    reason="$(node -e 'process.stdout.write((JSON.parse(process.argv[1]).targets[Number(process.argv[2])].reason)||"")' "$plan_json" "$i")"
    echo "  → skip $repo: $reason"
    bash "$SCRIPT_DIR/notify_discord.sh" "kaggle提出 skip $repo ($COMP_KEY): $reason" >/dev/null 2>&1 || true
    continue
  fi
  file="$(node -e 'process.stdout.write((JSON.parse(process.argv[1]).targets[Number(process.argv[2])].file)||"")' "$plan_json" "$i")"
  msg="$(node -e 'process.stdout.write((JSON.parse(process.argv[1]).targets[Number(process.argv[2])].message)||"")' "$plan_json" "$i") [slot:${slot_id}]"
  if [[ -n "${current_fingerprint[$repo]:-}" ]]; then
    msg+=" [artifact:${current_fingerprint[$repo]}]"
  fi
  kernel="$(node -e 'process.stdout.write((JSON.parse(process.argv[1]).targets[Number(process.argv[2])].kernel)||"")' "$plan_json" "$i")"
  version="$(node -e 'process.stdout.write(String((JSON.parse(process.argv[1]).targets[Number(process.argv[2])].version)||""))' "$plan_json" "$i")"
  output="$(node -e 'process.stdout.write((JSON.parse(process.argv[1]).targets[Number(process.argv[2])].output)||"")' "$plan_json" "$i")"
  if [[ -n "$kernel" && -n "$version" && -n "$output" ]]; then
    kernel_status="$(kaggle kernels status "$kernel" 2>&1 || true)"
    if [[ "$kernel_status" != *COMPLETE* ]]; then
      echo "  → ERROR: Notebook kernel is not COMPLETE: $kernel ($kernel_status)" >&2
      rc_all=2
      continue
    fi
    echo "  → Notebook提出: $repo kernel=$kernel version=$version output=$output"
    kaggle competitions submit -c "$COMP_SLUG" -k "$kernel" -v "$version" -f "$output" -m "$msg"; rc=$?
    echo "    exit=$rc"
    [[ $rc -ne 0 ]] && rc_all=$rc
    continue
  fi
  if [[ ! -f "$file" ]]; then
    echo "  → NOTICE: 提出物が見つかりません: $file （$repo）。ビルド後に再実行してください。" >&2
    bash "$SCRIPT_DIR/notify_discord.sh" "kaggle提出 skip $repo: 提出物なし $file" >/dev/null 2>&1 || true
    continue
  fi
  echo "  → 提出: $repo file=$file"
  kaggle competitions submit -c "$COMP_SLUG" -f "$file" -m "$msg"; rc=$?
  echo "    exit=$rc"
  [[ $rc -ne 0 ]] && rc_all=$rc
done

# Public score は提出直後には pending のことがある。ここで一度同期し、未確定分は次の改善枠の
# collectImproveContext が同じ冪等同期を再実行して、COMPLETEになった時点で必ず捕捉する。
score_csv="$(kaggle competitions submissions "$COMP_SLUG" --csv 2>/dev/null || true)"
if [[ -n "$score_csv" ]]; then
  score_sync="$(printf '%s\n' "$score_csv" | (
    cd "$REPO_ROOT" &&
    npx --no-install tsx src/runner-cli.ts kaggle-score-sync \
      --registry "$REGISTRY" --competition "$COMP_KEY"
  ) 2>/dev/null || true)"
  if [[ -n "$score_sync" ]]; then
    echo "  → score progression sync: $score_sync"
  fi
fi
exit $rc_all
