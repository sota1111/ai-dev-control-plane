# Sonnet Gold100 自動改善サイクル — 設計ドキュメント

対象: `scripts/ai/sonnet_gold_cycle_draft.ts` / `scripts/ai/sonnet_gold_cycle.sh` / crontab エントリ /
`src/lib/linearApi.ts` の二段ライフサイクル親再開。
関連 repo: `/workspaces/signate-messy-drive-rag`（測定・実装の対象）。

## 目的

SIGNATE 文書QAシステムの **Sonnet dev gold100 の net（match−wrong）を、人手ゼロの連続サイクルで最大化**する。
回答実行は定額 Sonnet（claude-mcp バックエンド）のみで **Gemini を実行しない**（前処理ビルドに限り Gemini 可）。
戦略順序は「**abstain を前処理（質問非依存の事前計算ストア）で消す → その後 wrong を減らす**」。

## 全体アーキテクチャ

```
crontab */10 * * * *（10分毎ポーリング）
   └─ sonnet_gold_cycle.sh（.env 読込）
        └─ sonnet_gold_cycle_draft.ts — 起票判定4条件:
             1. stop ファイル（docs/ai/auto_logs/sonnet_gold_cycle.stop）→ あれば skip
             2. env kill switch（SONNET_GOLD_CYCLE_ENABLED=0）→ skip
             3. 最小間隔（前回起票から SONNET_GOLD_CYCLE_MIN_INTERVAL_MIN 分、既定15）→ skip
             4. 直列ガード: ラベル sonnet-gold-cycle の Todo/In Progress/In Review issue が
                1件でもあれば skip（親・子の両方が対象）
        └─ 全条件クリア → 次サイクル issue を Linear へ起票
             （最新の台帳エントリ・前回申し送りコメントを本文へ自動埋込）

起票された親issue（Fable 担当）:
   分析（失敗調査・証拠つき帰属）→ 子issue 3〜6件を並列起票（opus 担当）
   → 親は In Review で子待ち
   → 全子完了で webhook が親を Todo へ自動再開（finalizeParentIfChildrenComplete）
   → 親が統合 focused → Sonnet dev gold100 ×1 → 台帳追記 → 申し送りコメント → 完了
   → （≤10分後）次サイクルが自動起票される
```

## 設計判断とその意図

### 1. 完了駆動を「イベント」でなく「ポーリング＋直列ガード」で実装した理由

- 安全性が**直列ガードだけで完結**する: 二重起票・サイクル並走が構造的に不可能（webhook にイベントハンドラを
  足す方式だと、再送・順序入れ替わり・多重発火の防御を別途持つ必要がある）
- 故障モードが「最大10分待つ」だけ: サイクル1周（実装＋測定で数時間）に対して遅延上限10分は無視できる
- 停止・再開が「ファイル1個 / crontab 1行」で完結し、可観測性（`auto_logs/sonnet_gold_cycle.log` に毎tick
  の判定理由が JSON で残る）が高い

### 2. 直列ガードが In Review を「未完了」に含める理由

親は子待ちで In Review に滞在する設計（二段ライフサイクル）のため、In Review を完了扱いにすると
子の実行中に次サイクルが起票されてしまう。完了した親は auto-accept が Done へ促進するので、
In Review 滞在は原則一時的（例外は human-review 系の保留のみ）。

### 3. 最小間隔（既定15分）の理由

サイクルが即座に失敗して完了する事態（設定ミス等）が起きたとき、10分毎に新サイクルを起票し続ける
スラッシングを防ぐ下限。正常時は1周が数時間なので実質影響しない。

### 4. 親=Fable / 子=opus の担当階層

親の仕事は「前回結果の失敗調査（証拠つき帰属 — 単発揺らぎで軸を閉じない）・改善クラスタの選定・
子への分解・統合測定・申し送り」= 判断業務なので最上位モデル（Fable）。
子は対象 idx が確定したコミット単位の実装なので opus。1サイクルで 3〜6 子・8〜15 idx を並列に進める
（旧: 親単独で2〜4件 → 改善量が不足したため 2026-08-12 に多子化）。

### 5. 二段ライフサイクル親の webhook 再開

`finalizeParentIfChildrenComplete`（linearApi.ts）は、全子完了時に
「二段ライフサイクル親（kaggle 改善サイクル / `[SONNET-GOLD]` サイクル）」を Todo へ再開する。
**タイトル正規表現で判定**しているため、サイクル種を増やす場合はここへの追加が必要
（2026-08-12 に SONNET-GOLD が漏れていて親が永久停滞する障害が実際に起きた — PR#384 で修正）。

### 6. 品質ガードレール（テンプレートに埋込・全サイクル共通）

- **Gemini 禁止**: 回答実行は claude-mcp のみ。毎 run で課金 $0 を機械確認。前処理ビルドのみ Gemini 可
- **無理な回答化をしない**: 証拠をストアに用意できない問いは棄権のまま（Incorrect −1 < Missing 0）。
  回答増の変更は必ずゲート（commit_gate / 書式契約）と対にする
- **focused 検証は番兵つき**（`run_focused_gate.py --dev`）: 既存正答10問の回帰検出器を必ず併走
- **帰属は証拠つき**: rejected/CLOSED 判定には発火テレメトリ or 同条件 A/B が必要。単発 run の数点差はノイズ扱い
- **official:false**: 本サイクルの全結果は dev。公式 net は flash 3.6 レーン（別管理）。LB 提出はしない
- gold値ハードコード禁止 / 事前計算は質問非依存の網羅計算のみ

## 運用

| 操作 | 方法 |
|---|---|
| 停止 | `touch docs/ai/auto_logs/sonnet_gold_cycle.stop`（次tickから skip） |
| 再開 | stop ファイル削除（≤10分で次サイクル起票） |
| 恒久停止 | crontab の該当行削除 |
| 方針変更 | `sonnet_gold_cycle_draft.ts` の `buildDescription` を編集（次サイクルから反映）。<br>実行中サイクルへは issue コメントで介入可（テンプレートの人間コメント尊重・newest-wins） |
| 手動即時起票 | `npx tsx scripts/ai/sonnet_gold_cycle_draft.ts --force`（`--skip-guard` で直列ガードも無視 — 通常使わない） |
| 状態確認 | `docs/ai/auto_logs/sonnet_gold_cycle_state.json`（lastCycle/lastIssue）・`sonnet_gold_cycle.log` |
| 成績確認 | 対象repo `docs/ai/sonnet_gold_history.jsonl`（サイクル毎の net と申し送り） |

## 既知の制約・注意

- **usage limit はアカウント全体で共有**: Sonnet gold100（~100分）＋Fable/opus ワーカーが同じ枠を使う。
  逼迫時はテンプレートの縮退ルール（gold100 スキップ・記録して続行）が効く
- 起票は Linear Issue cap（無料プラン250）の影響を受ける。cap 到達時は archive 運用
  （`scripts/ai/archive_linear_issues.sh`）
- webhook（`npm run start:webhook`）は **tsx 再読込しない** — control-plane の src 変更後は手動再起動が必要

## 履歴

- 2026-08-11: 初版（JST 4時間グリッド起票・親単独作業）。初回 SOT-2648
- 2026-08-11 PR#382: 親=分析・分解／子=並列実装の多子化、直列ガードに In Review 追加
- 2026-08-12 PR#384: webhook 親再開に SONNET-GOLD を追加（永久停滞障害の修正）
- 2026-08-12 PR#385: 完了駆動の連続モード化（時刻グリッド廃止・10分ポーリング＋最小間隔）
- 成績: baseline net18 → cycle4 net36（多子化初適用）→ 手動中間実測 net48（Cerebras 検索基盤＋裸回答契約、
  flash 公式 champion 40 を dev レーンが初超過）
