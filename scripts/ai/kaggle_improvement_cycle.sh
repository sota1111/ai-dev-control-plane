#!/usr/bin/env bash
# SOT-1913 / SOT-1933: Kaggle 改善サイクル cron（単一スケジュール JST [0,4,8,12,16,20]・1枠=1コンペ）。
#
# 設計（docs/kaggle-improvement-cycle.md / docs/ai/linear/SOT-1913.md v4）:
#   単一 cron を毎時起動し、この枠(JST hour)に割り当てられた1コンペ(rotation)を解決して、その
#   claude/gpt 2ターゲットだけを対象にガードを評価し、通過分に「改善方針の親Issue」を1本ずつ起案する。
#   cron は LLM を呼ばない。起案本文/ガード判定は決定的（src/lib/kaggleImprovement.ts）。
#   起案された親Issueは既存パイプライン（webhook→run_auto.sh→task-check 分解）が読み、順位向上の
#   子Issueへ分解して実装する（＝要求2）。子Issueは Todo + blockedBy で作られ依存順に自動実装される。
#   さらに（SOT-1913「日々提出できる状態」）同じ当番枠で当該コンペの現 champion 提出
#   （kaggle_targets_submit.sh）も行う。別スケジュールの提出 cron は持たず、1枠=1コンペ一巡で各コンペ
#   1日1提出が自然に成立する。active(2段kill switch)かつ --execute のときだけ実提出、それ以外は dry-run。
#
# ガード（runner-cli kaggle-improve-run が engine 経由で評価）:
#   1. active（registry.enabled && env KAGGLE_IMPROVE_ENABLED）でなければ何もしない。
#   2. Issue cap ガード（総 Issue 数 >= registry.issue_cap_guard）で停止。
#   3. worker cooldown 中は停止。
#   4. 前サイクル実行中ガード（project に Todo/In Progress の auto-improve 親があれば重複起案しない。
#      In Review を含む過去 Issue は現在の実行対象ではないため、次サイクルを妨げない）。
#   5. 新材料ガード（前回サイクル以降に新完了 Issue が無ければ起案しない）。
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

# worker cooldown 判定（codex / antigravity の cooldown ファイルに未来の resumeAt があれば active）。
LOG_DIR="$REPO_ROOT/docs/ai/auto_logs"
COOLDOWN=0
for w in codex antigravity; do
  f="$LOG_DIR/$w.cooldown.json"
  [[ -f "$f" ]] || continue
  active="$(node -e '
    try {
      const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      const ep=r.resumeAtEpoch||(r.resumeAt?Math.floor(Date.parse(r.resumeAt)/1000):0);
      process.stdout.write(ep && ep>Math.floor(Date.now()/1000) ? "1":"0");
    } catch(e){ process.stdout.write("0"); }
  ' "$f" 2>/dev/null)"
  [[ "$active" == "1" ]] && COOLDOWN=1
done

# Issue cap ガード用の総 Issue 数（best-effort・env で渡せる。未指定は 0＝ガード無効）。
ISSUE_COUNT="${KAGGLE_IMPROVE_ISSUE_COUNT:-0}"

echo "== Kaggle 改善サイクル (JST hour=${HOUR}, execute=${EXECUTE}, cooldown=${COOLDOWN}) =="

# runner-cli kaggle-improve-run: プラン計算（＋ --execute 時のみ Linear 起案）。
run_args=(kaggle-improve-run --registry "$REGISTRY" --hour "$HOUR"
  --issue-count "$ISSUE_COUNT" --cooldown "$COOLDOWN")
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
  if(o.executed){
    const c=(o.created||[]).map(x=>x.identifier).join(",")||"none";
    process.stdout.write(escalations.length
      ? `kaggle改善サイクル 要人間確認 comp=${comp}: ${escalations.join(" / ")}`
      : `kaggle改善サイクル JST${process.argv[2]} comp=${comp} 起案=${c}`);
  } else {
    const d=((o.plan&&o.plan.targets)||[]).filter(t=>t.action==="draft").length;
    process.stdout.write(escalations.length
      ? `kaggle改善サイクル(dry-run) plateau検知 comp=${comp}: ${escalations.join(" / ")}`
      : `kaggle改善サイクル(dry-run) JST${process.argv[2]} comp=${comp} draft対象=${d}`);
  }
' "$out_json" "$HOUR")"
bash "$SCRIPT_DIR/notify_discord.sh" "$summary" >/dev/null 2>&1 || true

# SOT-1913「日々提出できる状態」— 同じ当番枠で当該コンペの現 champion 提出も行う（別スケジュールの
# 提出 cron は持たない＝「提出専用ローテ廃止」の方針を維持）。1枠=1コンペ一巡なので各コンペ1日1提出
# が自然に成立する。起案が guard で skip されても提出は独立に試みる（＝必ず1日1回は提出しようとする）。
#   - active(2段 kill switch: registry.enabled && env KAGGLE_IMPROVE_ENABLED) かつ --execute のときだけ実提出。
#   - それ以外はドライラン（プラン表示のみ）。実提出でも submit.file 未整備なら kaggle_targets_submit.sh が
#     skip+通知して安全側に倒す（冪等: 当日提出済み/ cap 到達も skip）。
ACTIVE="$(node -e 'const o=JSON.parse(process.argv[1]||"{}");process.stdout.write(o.plan&&o.plan.active?"1":"0")' "$out_json")"
COMP="$(node -e 'const o=JSON.parse(process.argv[1]||"{}");process.stdout.write((o.plan&&o.plan.competition)||"")' "$out_json")"
if [[ -n "$COMP" ]]; then
  submit_args=(--competition "$COMP")
  if [[ "$EXECUTE" == "1" && "$ACTIVE" == "1" ]]; then
    submit_args+=(--execute)
    echo "== champion 提出（当番=${COMP}・実提出）=="
  else
    echo "== champion 提出（当番=${COMP}・ドライラン）=="
  fi
  bash "$SCRIPT_DIR/kaggle_targets_submit.sh" "${submit_args[@]}" || echo "  (提出ステップは非0終了・best-effort で継続)"
else
  echo "== champion 提出: この枠に当番コンペなし（skip）=="
fi

exit 0
