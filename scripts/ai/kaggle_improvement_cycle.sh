#!/usr/bin/env bash
# Kaggle 改善サイクル cron（JST [0,3,6,9,12,15,18,21]・各コンペ1日2枠）。
#
# 設計（docs/kaggle-improvement-cycle.md / docs/ai/linear/SOT-1913.md v4）:
#   単一 cron を毎時起動し、この枠(JST hour)に割り当てられた1コンペ(rotation)を解決して、その
#   claude/gpt 2ターゲットだけを対象にガードを評価し、通過分に「改善方針の親Issue」を1本ずつ起案する。
#   cron は LLM を呼ばない。起案本文/ガード判定は決定的（src/lib/kaggleImprovement.ts）。
#   起案された親Issueは既存パイプライン（webhook→run_auto.sh→task-check 分解）が読み、順位向上の
#   子Issueへ分解して実装する（＝要求2）。子Issueは Todo + blockedBy で作られ依存順に自動実装される。
#   提出は改善依存列の最終子Issueが、全ての実装・検証完了後に行う。cronは起案だけを担当し、
#   起案直後の古いartifactを提出しない。これにより「改善前artifactのduplicate skip」を完了結果として
#   誤記録する競合を防ぐ。
#
# 起案方針（順位最優先・「基本は起案する」）: engine(kaggle-improve-run) が残すガードは2つだけ。
#   1. active（registry.enabled && env KAGGLE_IMPROVE_ENABLED）でなければ何もしない（kill switch）。
#   2. 前サイクル実行中ガード（project に Todo/In Progress の auto-improve 親があれば重複起案しない。
#      In Review を含む過去 Issue は現在の実行対象ではないため、次サイクルを妨げない）。
# 旧ガード（Issue cap / worker cooldown / 新材料 / 測定不能）は起案停止理由にしない。Issue cap は
# 起案前にこのスクリプトが archive → 起案 で吸収する（下記 CAPACITY preflight）。
#
# 使い方:
#   bash scripts/ai/kaggle_improvement_cycle.sh                 # ドライラン（プラン表示＋記録・起案しない）
#   bash scripts/ai/kaggle_improvement_cycle.sh --execute       # 実起案（active 時のみ Linear に作成）
#   bash scripts/ai/kaggle_improvement_cycle.sh --hour 8        # JST hour を上書き（テスト用）
#   bash scripts/ai/kaggle_improvement_cycle.sh --only-scheduled # 現在時刻(JST)が枠でなければ何もしない
#
# 既定はドライラン（default OFF の2段 kill switch: env KAGGLE_IMPROVE_ENABLED + registry.enabled）。
# 有効化手順・kill switch は docs/kaggle-improvement-cycle.md を参照。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

REGISTRY="$SCRIPT_DIR/kaggle_targets_registry.json"
EXECUTE=0
ONLY_SCHEDULED=0
HOUR_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute) EXECUTE=1 ;;
    --only-scheduled) ONLY_SCHEDULED=1 ;;
    --hour) HOUR_OVERRIDE="$2"; shift ;;
    --hour=*) HOUR_OVERRIDE="${1#*=}" ;;
    --registry) REGISTRY="$2"; shift ;;
    --registry=*) REGISTRY="${1#*=}" ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ ! -f "$REGISTRY" ]]; then
  echo "ERROR: targets registry not found: $REGISTRY" >&2
  exit 2
fi

HOUR="${HOUR_OVERRIDE:-$(TZ=Asia/Tokyo date +%-H)}"

# --only-scheduled: 現在の JST hour が schedule_hours_jst に無ければ何もしない。
if [[ "$ONLY_SCHEDULED" == "1" ]]; then
  in_slot="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const h=Number(process.argv[2]);process.stdout.write((r.schedule_hours_jst||[]).includes(h)?"1":"0")' "$REGISTRY" "$HOUR")"
  if [[ "$in_slot" != "1" ]]; then
    echo "skip: JST hour ${HOUR} is not a scheduled slot ($(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write((r.schedule_hours_jst||[]).join(","))' "$REGISTRY"))"
    exit 0
  fi
fi

LOG_DIR="$REPO_ROOT/docs/ai/auto_logs"

# Issue上限リカバリ: 起案は「基本作成」方針なので cap で止めない。代わりに実起案(--execute)の前に総
# Issue 数を測り、trigger 以上なら archive_linear_issues.sh でスペースを空けてから起案する（skip せず
# 「アーカイブして新規作成」）。best-effort（測れない/失敗しても継続）。run_auto.sh の CAPACITY preflight と同作法。
ISSUE_CAP_TRIGGER="${ISSUE_CAP_TRIGGER:-245}"
if [[ "$EXECUTE" == "1" && -n "${LINEAR_API_KEY:-}" ]]; then
  total="$(bash "$SCRIPT_DIR/archive_linear_issues.sh" --print-total 2>/dev/null || echo '')"
  if [[ "$total" =~ ^[0-9]+$ ]] && (( total >= ISSUE_CAP_TRIGGER )); then
    echo "[CAPACITY] Linear issues=${total} >= trigger=${ISSUE_CAP_TRIGGER}; archiving before drafting"
    bash "$SCRIPT_DIR/archive_linear_issues.sh" --execute >/dev/null 2>&1 \
      || echo "[CAPACITY] WARN archive failed; continuing"
  fi
fi

echo "== Kaggle 改善サイクル (JST hour=${HOUR}, execute=${EXECUTE}) =="

# runner-cli kaggle-improve-run: プラン計算（＋ --execute 時のみ Linear 起案）。
run_args=(kaggle-improve-run --registry "$REGISTRY" --hour "$HOUR")
[[ "$EXECUTE" == "1" ]] && run_args+=(--execute)

out_json="$(cd "$REPO_ROOT" && npx --no-install tsx src/runner-cli.ts "${run_args[@]}" 2>/dev/null)"
if [[ -z "$out_json" ]]; then
  out_json="$(cd "$REPO_ROOT" && npx tsx src/runner-cli.ts "${run_args[@]}" 2>/dev/null)"
fi
if [[ -z "$out_json" ]]; then
  echo "ERROR: kaggle-improve-run の実行に失敗しました（tsx/runner-cli を確認）。" >&2
  exit 2
fi

# 表示 + 記録（append-only jsonl）。
HIST_FILE="$LOG_DIR/kaggle_improve.jsonl"
mkdir -p "$LOG_DIR"
ts="$(date -u +%FT%TZ)"
node -e '
  const fs=require("fs");
  const [, file, ts, hour, out] = process.argv;
  const o=JSON.parse(out||"{}");
  const rec={ ts, hour_jst:Number(hour), competition:o.plan&&o.plan.competition,
    active:o.plan&&o.plan.active, executed:!!o.executed,
    created:(o.created||[]).map(c=>c.identifier), skipped:(o.skipped||[]).length,
    reason:o.plan&&o.plan.reason };
  fs.appendFileSync(file, JSON.stringify(rec)+"\n");
  const comp=rec.competition||"(none)";
  console.log(`  コンペ(当番): ${comp}`);
  console.log(`  active: ${rec.active}  reason: ${rec.reason}`);
  if(o.executed){
    console.log(`  起案: ${ (o.created||[]).map(c=>c.identifier+" ("+c.project+")").join(", ")||"（なし）" }`);
    if((o.skipped||[]).length) console.log(`  skip: ${ o.skipped.map(s=>s.project+": "+s.reason).join(" / ") }`);
  } else {
    const draft=((o.plan&&o.plan.targets)||[]).filter(t=>t.action==="draft").map(t=>t.repo);
    console.log(`  ドライラン。起案対象(draft): ${ draft.join(", ")||"（なし）" }（実起案は --execute）`);
  }
  console.log(`  記録: ${file}`);
' "$HIST_FILE" "$ts" "$HOUR" "$out_json"

# Discord 通知（best-effort）。
summary="$(node -e '
  const o=JSON.parse(process.argv[1]||"{}");
  const comp=(o.plan&&o.plan.competition)||"(none)";
  const escalations=((o.plan&&o.plan.targets)||[])
    .filter(t=>String(t.reason||"").startsWith("plateau escalation:"))
    .map(t=>`${t.repo}: ${t.reason}`);
  const healthFailures=((o.plan&&o.plan.targets)||[])
    .filter(t=>String(t.reason||"").startsWith("measurement unavailable:"))
    .map(t=>`${t.repo}: ${t.reason}`);
  const alerts=[...new Set([...healthFailures,...escalations])];
  if(o.executed){
    const c=(o.created||[]).map(x=>x.identifier).join(",")||"none";
    process.stdout.write(alerts.length
      ? `kaggle改善サイクル 要人間確認 comp=${comp}: ${alerts.join(" / ")}`
      : `kaggle改善サイクル JST${process.argv[2]} comp=${comp} 起案=${c}`);
  } else {
    const d=((o.plan&&o.plan.targets)||[]).filter(t=>t.action==="draft").length;
    process.stdout.write(alerts.length
      ? `kaggle改善サイクル(dry-run) 要人間確認 comp=${comp}: ${alerts.join(" / ")}`
      : `kaggle改善サイクル(dry-run) JST${process.argv[2]} comp=${comp} draft対象=${d}`);
  }
' "$out_json" "$HOUR")"
bash "$SCRIPT_DIR/notify_discord.sh" "$summary" >/dev/null 2>&1 || true

echo "== artifact 提出: 起案直後は実行しません（改善依存列の最終子Issue完了後に実行）=="

exit 0
