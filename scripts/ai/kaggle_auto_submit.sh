#!/usr/bin/env bash
# SOT-1904: Kaggle 自動提出ランナー（優先度レジストリ駆動・1日5枠）。
#
# コンペ `pokemon-tcg-ai-battle` は最終評価に「直近2提出のみ」が反映される（+1日5提出上限）。
# scripts/ai/kaggle_submission_registry.json に「最終2枠に載せたい agent」を優先度付きで登録しておき、
# このスクリプトを AM0/4/8・PM4/8(JST) の5枠で（cron 等から）起動すると:
#   (1) `kaggle competitions submissions` で前回までの提出結果を確認し、
#   (2) その現況を docs/ai/kaggle/submission-history.jsonl に1行 append で【記録】し、
#   (3) src/lib/kaggleSubmission.ts の優先度ロジック（runner-cli kaggle-plan）で
#       「直近2提出＝enabled 中の優先度上位2」へ収束するよう次に出す1 agent を決め、
#   (4) `--execute` 指定時のみ、その agent の提出物を Kaggle へ提出する。
# 既定はドライラン（提出計画を表示するだけ）。実提出は人手ゲート運用（cron に --execute を付けて有効化）。
#
# 使い方:
#   bash scripts/ai/kaggle_auto_submit.sh                 # ドライラン（計画表示＋記録）
#   bash scripts/ai/kaggle_auto_submit.sh --execute       # 実提出（registry の submit.file が要る）
#   bash scripts/ai/kaggle_auto_submit.sh --only-scheduled # 現在時刻(JST)が schedule 枠のときだけ実行
#
# env: KAGGLE_COMPETITION（既定 registry の competition）。
# 設計の詳細ゲート: docs/ai/kaggle-final-submission-gate.md / docs/kaggle-submission.md。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

REGISTRY="$SCRIPT_DIR/kaggle_submission_registry.json"
EXECUTE=0
ONLY_SCHEDULED=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1 ;;
    --only-scheduled) ONLY_SCHEDULED=1 ;;
    --registry) REGISTRY="$2"; shift ;;
    --registry=*) REGISTRY="${1#*=}" ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ ! -f "$REGISTRY" ]]; then
  echo "ERROR: registry not found: $REGISTRY" >&2
  exit 2
fi

# competition: env override → registry。node で registry から読む（jq 非依存）。
COMP="${KAGGLE_COMPETITION:-$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(r.competition||"")' "$REGISTRY")}"
if [[ -z "$COMP" ]]; then echo "ERROR: competition unresolved" >&2; exit 2; fi

# --only-scheduled: 現在の JST hour が registry.schedule_hours_jst に無ければ何もしない。
if [[ "$ONLY_SCHEDULED" == "1" ]]; then
  now_hour="$(TZ=Asia/Tokyo date +%-H)"
  in_slot="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const h=Number(process.argv[2]);process.stdout.write((r.schedule_hours_jst||[0,4,8,16,20]).includes(h)?"1":"0")' "$REGISTRY" "$now_hour")"
  if [[ "$in_slot" != "1" ]]; then
    echo "skip: JST hour ${now_hour} is not a scheduled slot ($(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((r.schedule_hours_jst||[]).join(","))' "$REGISTRY"))"
    exit 0
  fi
fi

if ! command -v kaggle >/dev/null 2>&1; then
  echo "ERROR: kaggle CLI が見つかりません（pip install kaggle と認証を確認）。" >&2
  exit 2
fi

raw="$(kaggle competitions submissions -c "$COMP" 2>/dev/null)"
if [[ -z "$raw" ]]; then
  echo "ERROR: 提出履歴を取得できませんでした（認証/コンペ名 '$COMP' を確認）。" >&2
  exit 2
fi

# --- 提出履歴のパース（kaggle_final_slots.sh と同じ列前提: ref fileName date time description status score） ---
parse_agent() { local d="$1"; if [[ "$d" =~ ptcg-agent-([a-z0-9]+) ]]; then echo "${BASH_REMATCH[1]}"; else echo "?"; fi; }

mapfile -t body < <(printf '%s\n' "$raw" | tail -n +3)

today_utc="$(date -u +%F)"   # Kaggle の提出上限リセットは UTC 日付基準
today_count=0
declare -a recent_complete=()   # COMPLETE の agent（新しい順）

for line in "${body[@]}"; do
  [[ -z "${line// }" ]] && continue
  ref="$(awk '{print $1}' <<<"$line")"
  [[ "$ref" =~ ^[0-9]+$ ]] || continue
  # 行内の最初の YYYY-MM-DD を提出日とみなす。
  date_field="$(grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' <<<"$line" | head -1)"
  [[ "$date_field" == "$today_utc" ]] && today_count=$((today_count+1))
  status="$(grep -oE 'SubmissionStatus\.[A-Z]+' <<<"$line" | head -1)"
  agent="$(parse_agent "$line")"
  if [[ "$status" == "SubmissionStatus.COMPLETE" ]]; then
    recent_complete+=("$agent")
  fi
done

# 直近 COMPLETE agent（新しい順）を CSV に（先頭6件で十分）。
recent_csv="$(IFS=,; echo "${recent_complete[*]:0:6}")"

# --- 優先度ロジックで次の提出を決める ---
plan_json="$(cd "$REPO_ROOT" && npx --no-install tsx src/runner-cli.ts kaggle-plan \
  --registry "$REGISTRY" --recent "$recent_csv" --today-count "$today_count" 2>/dev/null)"
if [[ -z "$plan_json" ]]; then
  # tsx 未導入等のフォールバック（npx 経由で解決を試みる）。
  plan_json="$(cd "$REPO_ROOT" && npx tsx src/runner-cli.ts kaggle-plan \
    --registry "$REGISTRY" --recent "$recent_csv" --today-count "$today_count" 2>/dev/null)"
fi
if [[ -z "$plan_json" ]]; then
  echo "ERROR: kaggle-plan の実行に失敗しました（tsx/runner-cli を確認）。" >&2
  exit 2
fi

get() { node -e 'const o=JSON.parse(process.argv[1]||"{}");const v=o[process.argv[2]];process.stdout.write(v==null?"":Array.isArray(v)?v.join(","):String(v))' "$plan_json" "$1"; }
selected="$(get selected)"
reason="$(get reason)"
remaining="$(get remainingToday)"
target="$(get target)"
last_two="$(get currentLastTwo)"

# --- 前回の結果を【記録】（append-only jsonl） ---
HIST_DIR="$REPO_ROOT/docs/ai/kaggle"
HIST_FILE="$HIST_DIR/submission-history.jsonl"
mkdir -p "$HIST_DIR"
ts="$(date -u +%FT%TZ)"
node -e '
  const fs=require("fs");
  const [, file, ts, comp, today, recent, plan, mode] = process.argv;
  const rec = {
    ts, competition: comp, submitted_today: Number(today),
    recent_complete: recent ? recent.split(",").filter(Boolean) : [],
    plan: JSON.parse(plan||"{}"), mode,
  };
  fs.appendFileSync(file, JSON.stringify(rec)+"\n");
' "$HIST_FILE" "$ts" "$COMP" "$today_count" "$recent_csv" "$plan_json" "$([[ $EXECUTE == 1 ]] && echo execute || echo dry-run)"

# --- 表示 ---
echo "== Kaggle 自動提出プラン ($COMP) =="
echo "  今日の提出数: ${today_count}/$(get cap)  (残り ${remaining})"
echo "  最終2枠(目標): ${target}"
echo "  直近2提出(現況): ${last_two}"
echo "  選定: ${selected:-（なし）}"
echo "  理由: ${reason}"
echo "  記録: $HIST_FILE"

if [[ -z "$selected" ]]; then
  echo "  → 提出なし（${reason}）。"
  exit 0
fi

if [[ "$EXECUTE" != "1" ]]; then
  echo "  → ドライラン。実提出するには --execute を付けてください。"
  exit 0
fi

# --- 実提出（--execute） ---
sub_file="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const a=(r.agents||[]).find(x=>x.name===process.argv[2]);process.stdout.write((a&&a.submit&&a.submit.file)||"")' "$REGISTRY" "$selected")"
sub_msg="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const a=(r.agents||[]).find(x=>x.name===process.argv[2]);process.stdout.write((a&&a.submit&&a.submit.message)||("SOT-1904 auto-submit: "+process.argv[2]))' "$REGISTRY" "$selected")"

if [[ -z "$sub_file" ]]; then
  echo "  → NOTICE: agent '$selected' に submit.file 未設定のため実提出をスキップ。" >&2
  echo "     registry の agents[].submit.file に提出物パスを設定してください（docs/kaggle-submission.md）。" >&2
  exit 3
fi
if [[ ! -f "$sub_file" ]]; then
  echo "  → NOTICE: 提出物が見つかりません: $sub_file （agent '$selected'）。ビルド後に再実行してください。" >&2
  exit 3
fi

echo "  → 提出: agent=$selected file=$sub_file"
kaggle competitions submit -c "$COMP" -f "$sub_file" -m "$sub_msg"
rc=$?
echo "  提出コマンド exit=$rc"
exit $rc
