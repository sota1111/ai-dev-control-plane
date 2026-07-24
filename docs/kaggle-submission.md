# Kaggle 自動提出コントラクト（core = ai-dev-control-plane, SOT-1904）

Kaggle コンペ **`pokemon-tcg-ai-battle`** への提出を、**優先度レジストリ駆動で1日5枠・自動**に出すための
共有コントラクト。全 PTCG エージェント repo（`ptcg-agent-fable` / `-take` / `-matsu` / `-ume` /
`-debate` …）はこの文書を**提出順序の正**として参照する。個別 repo に提出スケジュールを実装しない。

> 最終評価は **直近2提出のみ**が反映される（+1日5提出上限）。詳細な選定/入れ替えゲート（収束判定・
> ノイズ幅・league KPI）は [`docs/ai/kaggle-final-submission-gate.md`](ai/kaggle-final-submission-gate.md) を参照。
> 本書はその**自動化**（誰をいつ出すか）を定義する。

---

## 1. 決められた場所（レジストリ）

提出したい agent は **`scripts/ai/kaggle_submission_registry.json`**（core 内の唯一の登録場所）に
優先度付きで登録する。`config/` は harness 保護下のため、Kaggle スクリプト群と同居させている。

```jsonc
{
  "competition": "pokemon-tcg-ai-battle",
  "daily_submission_cap": 5,               // Kaggle の1日提出上限
  "schedule_hours_jst": [0, 4, 8, 16, 20], // AM0/4/8・PM4/8
  "agents": [
    { "name": "fable", "priority": 1, "enabled": true,
      "submit": { "file": "<提出物パス>", "message": "..." } },
    { "name": "take",  "priority": 2, "enabled": true,
      "submit": { "file": "<提出物パス>", "message": "..." } },
    { "name": "matsu", "priority": 3, "enabled": false },
    { "name": "debate","priority": 4, "enabled": false }
  ]
}
```

- **priority**（1=最上位）… 最終2枠 = `enabled` の中で priority 上位2 agent。
- **enabled** … 自動提出ローテーションの対象か。計測目的の agent は `false`（優先度は保持）。
- **submit.file** … `kaggle competitions submit -f` に渡す提出物パス。**未設定なら `--execute` は
  その agent をスキップ**（＝安全側）。各 agent repo でビルドした提出物のパスをここに配線する。
- **submit.message** … 提出メッセージ（`-m`）。省略時は既定メッセージ。

登録を変えるだけ（コード変更不要）で、どの agent を最終2枠に載せるか・優先度・有効/無効を切り替えられる。
昇格判定（例: debate が下位枠を上回った）で入れ替える場合も、この JSON の `enabled`/`priority` を編集する。

## 2. スケジュール（1日5枠）

`schedule_hours_jst = [0,4,8,16,20]`（AM0時・AM4時・AM8時・PM4時・PM8時, JST）。Kaggle の1日提出上限
（5回）に合わせた5枠。cron 例（core repo ルートで実行）:

```cron
# JST の 0/4/8/16/20 時に自動提出（--execute で実提出。まずは付けずにドライラン運用でも可）
0 0,4,8,16,20 * * *  cd /workspaces/ai-dev-control-plane && TZ=Asia/Tokyo bash scripts/ai/kaggle_auto_submit.sh --execute >> docs/ai/kaggle/cron.log 2>&1
```

- コンテナの TZ が JST でない場合は上のように `TZ=Asia/Tokyo` を付ける（cron の時刻解釈用にも
  crontab 側 TZ 設定が要る環境あり）。
- 1本の毎時 cron から回したい場合は `--only-scheduled` を付けると、現在の JST hour が
  `schedule_hours_jst` の枠のときだけ実行する。
- **提出上限リセットは UTC 基準**（Kaggle 仕様）。当日提出数のカウントは UTC 日付で行う。

## 3. 実行時の挙動（前回結果の確認と記録）

`bash scripts/ai/kaggle_auto_submit.sh [--execute] [--only-scheduled]`:

1. `kaggle competitions submissions -c <competition>` で**前回までの提出結果を確認**（直近の COMPLETE
   agent 列と、当日(UTC)の提出数）。
2. その現況＋提出計画を **`docs/ai/kaggle/submission-history.jsonl` に1行 append で記録**（append-only。
   git 管理外）。
3. 優先度ロジック（`src/lib/kaggleSubmission.ts` / `runner-cli kaggle-plan`）で、
   **「直近2提出 = enabled 中の優先度上位2」に収束**するよう次に出す1 agent を選ぶ:
   - 当日提出数が上限なら**提出しない**。
   - target（上位2）が直近2枠から欠けていれば、その欠けている最上位 agent を出して**復元**。
   - 揃っていれば上位2を交互に出して**最新2枠を維持**（計測提出で押し出されても数枠内で復元）。
4. `--execute` 指定時のみ、その agent の `submit.file` を `kaggle competitions submit` で提出。既定は
   **ドライラン**（計画表示と記録のみ）。

## 4. ptcg-agent repo 側の役割

各 agent repo は **提出物のビルド**だけ担当し、**提出のタイミング/順序は本コントラクトに委譲**する:

- 昇格 champion の提出物（`submission.tar.gz` 等）をビルドし、そのパスを core の registry
  `agents[].submit.file` に配線する（共有パス or 各 repo チェックアウト）。
- 提出前に **Kaggle exec 互換ゲート**（`kaggle-exec-runtime-gate` memory）を通す。
- repo 独自の cron/提出スクリプトは持たない（重複提出で最終2枠が乱れるのを防ぐ）。

## 5. 関連

- 選定/入れ替えの運用ゲート: [`docs/ai/kaggle-final-submission-gate.md`](ai/kaggle-final-submission-gate.md)
- 現況の読み取り確認: `bash scripts/ai/kaggle_final_slots.sh fable take`
- 選定ロジック（単体テスト済）: `src/lib/kaggleSubmission.ts` / `src/__tests__/kaggleSubmission.test.ts`
- ランナー: `scripts/ai/kaggle_auto_submit.sh` / CLI: `runner-cli kaggle-plan`
