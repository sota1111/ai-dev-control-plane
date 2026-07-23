#!/usr/bin/env bash
# SOT-1904: 最終提出2枠の現況を Kaggle 実データから集約するヘルパー。
#
# コンペ `pokemon-tcg-ai-battle` は最終評価に「直近2提出のみ」が反映される（+1日5提出上限）。
# 計測目的の提出が挟まると最終2枠が意図せず入れ替わるため、この補助スクリプトで
#   (1) 全 COMPLETE 提出の収束スコア一覧
#   (2) 現在アクティブな最終2枠（直近2提出）
#   (3) 意図した2枠（引数）との一致判定＝入れ替え/復元が必要か
# をワンショットで確認する。詳細な選定ゲートは docs/ai/kaggle-final-submission-gate.md を参照。
#
# 使い方:
#   bash scripts/ai/kaggle_final_slots.sh                 # 現況一覧＋直近2枠を表示
#   bash scripts/ai/kaggle_final_slots.sh fable take      # 意図した2枠との一致も判定
#
# 読み取り専用: Kaggle への提出は一切行わない（再提出は人手ゲート、手順書参照）。
# Best-effort: kaggle CLI 不在・認証エラー時はメッセージを出して非ゼロ終了。

set -uo pipefail

COMP="${KAGGLE_COMPETITION:-pokemon-tcg-ai-battle}"
INTENDED=("$@")

if ! command -v kaggle >/dev/null 2>&1; then
  echo "ERROR: kaggle CLI が見つかりません。pip install kaggle と認証(~/.kaggle)を確認してください。" >&2
  exit 2
fi

raw="$(kaggle competitions submissions -c "$COMP" 2>/dev/null)"
if [[ -z "$raw" ]]; then
  echo "ERROR: 提出履歴を取得できませんでした（認証/コンペ名 '$COMP' を確認）。" >&2
  exit 2
fi

# ヘッダ2行(見出し + 区切り)を除いた本体を、日付降順の入力そのままで処理する。
# 各行から agent 名(ptcg-agent-<name>)・ref・score・status を抽出。
parse_agent() {
  # $1 = description 文字列
  local desc="$1"
  if [[ "$desc" =~ ptcg-agent-([a-z0-9]+) ]]; then
    echo "${BASH_REMATCH[1]}"
  else
    echo "?"
  fi
}

# 各提出を「ref|date|agent|status|score」のTSV風に整形。CLIの列幅に依存しないよう
# ref(先頭トークン)・末尾の status/score を掴み、中間を description として扱う。
mapfile -t body < <(printf '%s\n' "$raw" | tail -n +3)

declare -a complete_lines=()   # 表示用（COMPLETE のみ, 新しい順）
declare -a recent_agents=()    # 直近提出の agent（COMPLETE のみ, 新しい順）
declare -a recent_refs=()
declare -a recent_scores=()

for line in "${body[@]}"; do
  [[ -z "${line// }" ]] && continue
  ref="$(awk '{print $1}' <<<"$line")"
  [[ "$ref" =~ ^[0-9]+$ ]] || continue
  status="$(grep -oE 'SubmissionStatus\.[A-Z]+' <<<"$line" | head -1)"
  # score = status の直後に現れる最初の数値（COMPLETE のときのみ存在）
  score="$(sed -E 's/.*SubmissionStatus\.[A-Z]+[[:space:]]+([0-9]+(\.[0-9]+)?).*/\1/;t;d' <<<"$line")"
  agent="$(parse_agent "$line")"
  if [[ "$status" == "SubmissionStatus.COMPLETE" ]]; then
    complete_lines+=("$(printf '%-10s %-8s %-8s %s' "$ref" "$agent" "${score:-?}" "COMPLETE")")
    recent_agents+=("$agent")
    recent_refs+=("$ref")
    recent_scores+=("${score:-?}")
  fi
done

echo "== コンペ: $COMP =="
echo "== COMPLETE 提出（新しい順, score=収束途中を含む公開スコア） =="
printf '%-10s %-8s %-8s %s\n' "ref" "agent" "score" "status"
printf '%s\n' "${complete_lines[@]}"

echo
echo "== 現在アクティブな最終2枠（= 直近2提出, 最終評価に反映） =="
if (( ${#recent_agents[@]} >= 2 )); then
  printf '  1) %s  ref=%s  score=%s\n' "${recent_agents[0]}" "${recent_refs[0]}" "${recent_scores[0]}"
  printf '  2) %s  ref=%s  score=%s\n' "${recent_agents[1]}" "${recent_refs[1]}" "${recent_scores[1]}"
else
  echo "  （COMPLETE 提出が2件未満）"
fi

if (( ${#INTENDED[@]} == 2 )) && (( ${#recent_agents[@]} >= 2 )); then
  echo
  echo "== 意図した2枠との一致判定 =="
  echo "  意図: ${INTENDED[0]} + ${INTENDED[1]}"
  cur="$(printf '%s\n' "${recent_agents[0]}" "${recent_agents[1]}" | sort | tr '\n' ' ')"
  want="$(printf '%s\n' "${INTENDED[0]}" "${INTENDED[1]}" | sort | tr '\n' ' ')"
  if [[ "$cur" == "$want" ]]; then
    echo "  => OK: 直近2提出が意図どおり。復元不要。"
  else
    echo "  => 不一致: 最終2枠が計測提出等で押し出されています。復元手順（意図した agent の再提出）が必要。"
    echo "     復元例: 意図した2枠のうち欠けている agent を1本再提出すると、直近2提出が {再提出, 直前champion} に戻ります。"
  fi
fi
