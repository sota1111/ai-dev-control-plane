#!/usr/bin/env bash
# SOT-1913 / SOT-1934: 「取り組み完了時に提出」— マルチコンペ champion 提出（コンペ内選定機構なし）。
#
# SOT-1904 の単一コンペ専用・直近2提出収束ロジック（kaggle_auto_submit.sh / runner-cli kaggle-plan）は
# **この経路では使わない**。提出対象は常にそのターゲットの現 champion（registry の submit.file）。別
# スケジュールの提出 cron は持たず、当番コンペの取り組み完了時にこのスクリプトを呼んで提出する
# （1枠=1コンペ一巡で各コンペ1日1提出が自然に成立）。翌日の同じコンペ枠での前回結果確認は起案側
# （SOT-1932 の材料収集）で行う。
#
# 動作:
#   (1) --competition <key>（または --hour から rotation で解決）でコンペを決める。
#   (2) その Kaggle slug の提出履歴を取得し、各ターゲット(repo)の当日提出数を数える（冪等判定用）。
#   (3) runner-cli kaggle-champion-plan で各ターゲットの提出プラン（submit/skip・収束なし）を得る。
#   (4) --execute 指定時のみ、action=submit のターゲットの champion を Kaggle へ提出する。
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

# 各 repo の当日提出数を数える（Kaggle 履歴の description に repo 名が入る前提・best-effort）。
today_utc="$(date -u +%F)"
declare -A today_count
for repo in "${REPOS[@]}"; do today_count["$repo"]=0; done

if command -v kaggle >/dev/null 2>&1; then
  raw="$(kaggle competitions submissions -c "$COMP_SLUG" 2>/dev/null)"
  if [[ -n "$raw" ]]; then
    while IFS= read -r line; do
      [[ -z "${line// }" ]] && continue
      d="$(grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' <<<"$line" | head -1)"
      [[ "$d" == "$today_utc" ]] || continue
      for repo in "${REPOS[@]}"; do
        if grep -q "$repo" <<<"$line"; then today_count["$repo"]=$(( ${today_count["$repo"]} + 1 )); fi
      done
    done < <(printf '%s\n' "$raw" | tail -n +3)
  fi
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

# 提出プランを得る（収束なし・常に champion）。
plan_json="$(cd "$REPO_ROOT" && npx --no-install tsx src/runner-cli.ts kaggle-champion-plan \
  --registry "$REGISTRY" --competition "$COMP_KEY" --submitted "$submitted_json" 2>/dev/null)"
if [[ -z "$plan_json" ]]; then
  plan_json="$(cd "$REPO_ROOT" && npx tsx src/runner-cli.ts kaggle-champion-plan \
    --registry "$REGISTRY" --competition "$COMP_KEY" --submitted "$submitted_json" 2>/dev/null)"
fi
if [[ -z "$plan_json" ]]; then
  echo "ERROR: kaggle-champion-plan の実行に失敗しました（tsx/runner-cli を確認）。" >&2
  exit 2
fi

echo "== Kaggle 完了トリガ提出 ($COMP_KEY / $COMP_SLUG) =="
node -e '
  const o=JSON.parse(process.argv[1]||"{}");
  for(const t of (o.targets||[])){
    console.log(`  ${t.repo} [${t.lineage}] → ${t.action}  (${t.reason})`);
  }
' "$plan_json"

# 記録（append-only jsonl）。
HIST_DIR="$REPO_ROOT/docs/ai/kaggle"; HIST_FILE="$HIST_DIR/submission-history.jsonl"; mkdir -p "$HIST_DIR"
ts="$(date -u +%FT%TZ)"
node -e '
  const fs=require("fs");
  const [, file, ts, plan, mode] = process.argv;
  fs.appendFileSync(file, JSON.stringify({ ts, source:"kaggle_targets_submit", mode, plan:JSON.parse(plan||"{}") })+"\n");
' "$HIST_FILE" "$ts" "$plan_json" "$([[ $EXECUTE == 1 ]] && echo execute || echo dry-run)"

if [[ "$EXECUTE" != "1" ]]; then
  echo "  → ドライラン。実提出するには --execute を付けてください。"
  exit 0
fi

if ! command -v kaggle >/dev/null 2>&1; then
  echo "ERROR: kaggle CLI が見つかりません（実提出には認証が必要）。" >&2
  exit 2
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
  msg="$(node -e 'process.stdout.write((JSON.parse(process.argv[1]).targets[Number(process.argv[2])].message)||"")' "$plan_json" "$i")"
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
exit $rc_all
