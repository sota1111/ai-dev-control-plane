# AI Dev Control Plane 設計方針

この文書は、AI Dev Control Plane リポジトリ全体に適用する設計原則、責務境界、実行モデル、
状態管理、Kaggle 運用、障害復旧、テスト方針を日本語で定義する。実装詳細は末尾の関連文書を参照し、
設計と実装が矛盾する場合は、コードだけを修正せず、この文書と回帰テストも同じ変更で更新する。

## 1. システムの目的と責務

Linear Issue を作業の起点として、AI による分解、実装、検証、提出、報告、復旧を一貫して統制する。
システムは人間の介入を前提とせず自律的に継続し、Kaggle においては leaderboard 順位の最大化を
目的関数とする。人間は方針変更・例外承認・終端判断のみを担う。

## 2. 設計原則

安全性、冪等性、状態収束、証跡性、責務分離を、速度や一時的な成功より優先する。加えて自律性を
原則とし、安全なデフォルトが存在する限り人間の応答を待って停止しない。

## 3. 全体アーキテクチャ

cron／scheduler、Linear webhook、永続 queue、runner、worker、GitHub、Kaggle、target repository を疎結合に接続する。

```text
cron / Linear webhook
          ↓
     persistent queue
          ↓
 execution plan / runner
          ↓
     solo / graph worker
          ↓
 verification / GitHub / Linear
          ↓
 parent aggregation / Kaggle submission
          ↓
 leaderboard sync ──► 次周期の改善起案へ還流
```

## 4. Control Plane と Target Repository の境界

control-plane は実行と状態を統制し、target repository は競技コード、評価コード、テスト、提出 artifact を所有する。

## 5. Issue の再帰的分解

Issue は親・子・孫の三階層に限定せず、最終的に原則一コミットで完了できる末端 Issue になるまで再帰的に分解する。

## 6. 分解判断基準

複数責務、独立した検証、異なる依存関係、複数コミットが含まれる場合は、現在の Issue を直接実装せず子 Issue へ分解する。

## 7. 非末端 Issue の責務

子を持つ Issue は親として、直下子の作成、依存管理、成果集約、自身の受け入れ条件の再判定を担当する。

## 8. 末端 Issue の責務

末端 Issue だけが、限定された一つの変更を実装・検証し、原則一コミットとして直上親へ成果を返す。

## 9. Issue とコミットの対応

末端 Issue、コミット、PR、最上位 Issue を相互に追跡可能にし、どの変更がどの要求を満たしたかを残す。

## 10. Issue 間の依存関係

実行順序が必要な Issue のみに `blockedBy` を設定し、独立した Issue は lane と worktree が許す範囲で並行実行する。

## 11. Issue 状態モデル

Todo は未着手、In Progress は実行中、In Review は受け入れ判定待ち、Blocked は解除条件待ち、
On Hold は自動再実行停止を表す。In Review は原則として自動受け入れ判定（後述「自動受け入れと
人間確認の例外」）で解消され、人間確認待ちとして滞留させるのは例外条件に該当する場合のみとする。

## 12. 完了状態の再帰的伝播

末端の完了を直上親が集約し、その結果をさらに上位親へ一段ずつ伝え、階層を飛び越えて完了させない。

## 13. 親 Issue の再開条件

全直下子が In Review または正当な終端状態になった場合だけ親を再開し、最終子が親の集約処理を代行してはならない。

## 14. Webhook による高速経路

Linear の作成・更新イベントを受け、低遅延で queue 投入、依存解除、親再開を試みるが、唯一の状態根拠にはしない。

## 15. Reaper による状態収束

webhook 欠落、サーバー停止、外部 integration 経由の更新があっても、Linear の現在状態を再照合して正しい状態へ収束させる。

## 16. 早すぎる Done の防止

runner が所有中の Issue が GitHub 連携などで Done になった場合は In Review に補正し、未完了作業を隠さない。
自動受け入れ判定を通過して Done になった Issue はこの補正の対象にしない。

## 17. 人間操作の保護

実行終了後に人間が設定した Done、Canceled、Duplicate は自動処理で覆さず、明示的な終端判断として尊重する。

## 18. Queue 設計

Issue ID、優先度、依存関係、retry 時刻、親子情報、試行理由を永続化し、プロセス再起動後も処理順を復元する。

## 19. Lane と直列化

同じ repository または branch への競合変更を防ぐため lane と lock を用い、共有作業領域への書き込みを直列化する。

## 20. Worktree 分離

並行実行時は Issue または branch ごとに worktree を分け、別 Issue の未コミット変更や成果物を混在させない。

## 21. Execution Plan

Linear directive と既定設定から solo／graph、worker、model、reasoning、handoff を一意に解決し、その理由をログへ残す。

## 22. Solo 実行

一つの worker が一つの Issue について、分解判断から実装、検証、GitHub、Linear 報告まで必要な工程を担当する。

## 23. Graph 実行

複数役割を宣言的な pipeline graph で接続し、検証失敗や再実装を上限付きの明示経路で循環させる。

## 24. Worker 選択

Claude、Codex、Antigravity の割り当ては worker 設定を既定とし、Linear directive による Issue 単位の指定を優先する。

## 25. Model と Reasoning 指定

分解を担当する非末端 Issue と実装を担当する末端 Issue で、異なる model／reasoning を指定できるようにする。

## 26. Worker Handoff

利用制限や一時障害時は部分レポートと実行文脈を次候補へ渡し、作業を最初から無条件にやり直さない。

## 27. Worker 失敗分類

usage limit、policy refusal、認証失敗、crash、invalid report、人間待ちを区別し、それぞれ適切な復旧経路へ送る。
認証失敗は資格情報の自動更新（後述「Secret 管理」）を試行した後にのみ人間対応へ分類する。

## 28. 長時間 Solo 実行

solo には harness の wall-clock timeout を設けず、必要な評価や学習が完了するまで同じ worker session を維持する。

## 29. Background Process 管理

background 処理を使う場合は PID、ログ、出力、開始条件、完了条件を記録し、worker 終了前に結果を確認する。

## 30. 待機方法

`ScheduleWakeup` や待機文で run を終了せず、時間を区切った foreground poll を繰り返して最終契約を必ず出力する。

## 31. 重複 Writer 防止

resume／retry 時は既存 PID と出力を確認し、同じ artifact や結果ファイルへ複数 process を起動しない。

## 32. Detached Run

`long-run` Issue は sentinel、done marker、inflight 記録を伴って切り離し、runner の reaper が完了後処理を回収する。

## 33. Server 再起動時の復旧

起動時に queue、inflight、sentinel、PID、Linear 状態を照合し、生存中の run を壊さず stale 状態だけを回収する。

## 34. 停滞検出と Watchdog

wall-clock timeout を設けない代わりに、長時間 run には heartbeat（ログ・進捗 artifact の定期更新）を
義務付ける。無進捗時間が閾値を超えた run は「生きているが進んでいない」状態として watchdog が検出し、
状況の記録、安全な回収、再起動または handoff を人間なしで行う。reaper の「終了後の回収」とは別に、
実行中の停滞を扱う経路として維持する。

## 35. 完了契約

exit code だけで成功とせず、Linear 状態、`## Acceptance`、`## Linear Report`、`## Next Action`を併せて判定する。

## 36. 品質ゲート

lint、typecheck、unit test、必要な e2e、差分確認、受け入れ条件、CI を通過した変更だけを完了候補とする。

## 37. 自動受け入れと人間確認の例外

品質ゲートと実挙動検証（実際に動かして受け入れ条件を確認する）を通過した定常 Issue は、人間を
待たず自動で Done にする。人間確認（In Review での滞留）を必須とするのは次の例外のみとする:
設計方針の変更、破壊的操作や取り消し困難な外部影響、認可境界・secret・支出に触れる変更、
Linear directive による明示指定。人間が行った終端判断の尊重（前述）は変わらない。

## 38. GitHub 運用

feature branch、意味のある commit、PR、CI、merge、Linear 同期の順を守り、原則として main へ直接 push しない。

## 39. PR 所有単位

原則として最上位 Issue が末端 Issue のコミットを集約した PR を所有し、repository 境界がある場合だけ分割する。

## 40. Linear 報告

分解判断、進捗、検証、PR、merge、残課題を Linear に記録し、正式な作業状態をチャットやローカルログだけに置かない。

## 41. Kaggle 改善サイクル

各 competition／lineage で前回結果を確認し、改善起案、再帰分解、実装、集約、提出を定期的に実行する。
改善起案は leaderboard フィードバック（次節）と実験台帳（後述)を入力とし、何を最適化しているかを
サイクルごとに明示する。

## 42. Leaderboard フィードバック

Kaggle の一次 KPI は leaderboard スコアと順位であり、提出後に自動取得して lineage ごとに履歴化する。
ローカル評価はあくまで代理指標として扱い、順位の推移（絶対スコアと相対順位の両方）を次周期の
改善起案と資源配分の入力にする。

## 43. Oracle ドリフト検出と再アンカリング

ローカル評価と leaderboard の乖離（ローカル飽和なのに順位が低下する等）を drift として監視する。
drift を検出した lineage では局所 A/B を続けず、再アンカリング（holdout・GT の再整備、blind LB
probing、評価系の再構築）を明示的なサイクル工程として起動する。

## 44. Kaggle Issue 階層

改善サイクル親から改善軸、評価、実装を必要な深さまで分解し、末端を一コミット単位にする。

## 45. Kaggle 提出所有者

中間・末端 Issue は提出せず、全階層を集約した最上位の改善サイクル Issue だけが提出する。

## 46. Screen と Confirm

候補を軽量な screen で絞り、独立 seed や holdout を使う confirm で再検証して昇格可否を決める。

## 47. Champion と Candidate

champion 昇格を提出の必須条件にせず、検証済み candidate も提出可能とし、選定理由と対応する評価を記録する。

## 48. 実験台帳

lineage ごとに、試した改善軸、評価結果、昇格可否、飽和状態を機械可読な台帳として target repository に
保持する。改善起案時は台帳の参照を必須とし、非昇格が確定した軸を新しい根拠なしに再試行しない。
セッション記憶や個別 worker の記憶に依存せず、worker が交代しても探索履歴が引き継がれるようにする。

## 49. 飽和時の戦略転換

改善軸の飽和は障害ではなく、戦略転換の契機として扱う。連続 N 回の非昇格が確定した lineage では、
探索軸のクラスを段階的に強制切替する（局所チューニング → データ／oracle 整備 → アーキテクチャ変更
→ 外部知識の取り込み）。全段階を尽くしても進まない場合は、人間を待って停止するのではなく、
計算資源を他の competition／lineage へ再配分し、当該 lineage は維持提出に縮退する。

## 50. 資源配分

usage limit、日次提出枠、GPU、実行時間という有限資源を、competition ごとの期待順位ゲイン
（メダル境界との距離、残された改善余地、締切までの残時間）に基づいて適応的に配分する。
配分判断とその根拠は機械可読に記録し、定期的に再評価する。

## 51. 締切と最終提出選定

competition の締切を registry で追跡し、締切接近時は探索から収束へモードを切り替える
（新規軸の起案を止め、検証済み candidate の確定と最終提出選定を優先する）。最終提出枠の選定は
leaderboard 実績、ローカル評価、リスク分散（性質の異なる 2 枠）を基準に自動で行い、人間の承認を
前提としない。選定理由は証跡として残す。

## 52. Artifact 契約

提出物、生成元 commit、評価結果、exec 互換性、fingerprint を結び付け、提出内容を再現可能にする。

## 53. Fingerprint 設計

source、evaluation、exec、artifact の fingerprint を分離し、変更の種類と重複を lineage 単位で正確に判定する。

## 54. 重複提出判定

同一 artifact の再提出と新しい改善 artifact の提出を区別し、submit／skip の理由を機械可読な証跡へ残す。

## 55. Lineage 分離

Claude 系と GPT 系の repository、artifact、score、submission history を混在させず、独立した lineage として扱う。

## 56. PENDING 採点の扱い

採点未確定でも改善を停止せず、既知のローカル評価と履歴を使って次周期を進め、score は後から冪等に同期する。

## 57. Kaggle スケジュール

competition ごとの UTC／JST 枠、lineage ごとの一日実行回数、Kaggle の日次提出上限を registry に明示する。
registry は静的な上限を定めるものであり、上限内での実際の配分は資源配分（前述）に従う。

## 58. 提出 Helper

worker は Kaggle CLI を直接呼ばず、lineage、枠、fingerprint、artifact を検証する control-plane helper を使う。

## 59. Secret 管理

Linear、GitHub、Kaggle、Discord の認証情報をコードやログへ書かず、統一された secret 取得経路を使用する。
資格情報は定期的に健全性を検査し、期限切れ・失効は可能な限り自動更新する。自動更新が不可能な失効のみを
人間対応として Linear に記録する。

## 60. Webhook 署名検証

Linear と Discord の webhook は署名を検証してから処理し、署名なし開発モードは明示的に可視化する。

## 61. Agent Security の認可境界

セキュリティ課題では対象 scope と認可条件を確認し、policy refusal を通常の worker availability 障害と混同しない。

## 62. 可観測性

run log、queue history、leg metrics、resume metadata、Kaggle progression（leaderboard スコア・順位履歴を含む）、
Linear コメントから実行経緯を追跡可能にする。

## 63. ログと Artifact の保持

運用ログ、評価結果、提出証跡を用途別に保存し、一時ファイル、rotation 対象、長期証跡の境界を定める。

## 64. 障害検出と分類

障害を自動復旧可能、一時待機、人間対応必須、恒久修正必要に分類し、理由と観測証拠を残す。
改善軸の飽和は障害に分類せず、戦略転換（前述）の経路へ送る。

## 65. Retry と Cooldown

retry 可能な障害には backoff と `retryAt` を設定し、usage limit や一時認証失敗中の無意味な連続実行を防ぐ。

## 66. Blocked の扱い

安全な自動復旧を尽くした後だけ Blocked とし、理由、解除条件、必要な人間入力を Linear に記録する。
安全なデフォルトが存在する限り Blocked や人間待ちにせず、デフォルトで進めた事実と根拠を開示する。

## 67. Idempotency

Issue 作成、queue 投入、親再開、コメント、提出、score 同期は、再実行しても重複結果を作らないよう設計する。

## 68. Fail-open と Fail-closed

通知など補助処理は fail-open、認証、提出、完了、artifact 整合性など安全境界は fail-closed とする。

## 69. 設定管理

環境変数、registry、Linear directive、runtime state の責務と優先順位を分け、設定と実行結果を同じ項目へ混在させない。

## 70. 再起動要件

prompt と shell script は次回 run から反映されるが、webhook server の TypeScript 変更は process 再起動を必要とする。

## 71. Migration 方針

schema、registry、fingerprint、queue 形式を変える場合は、旧データの読み取り互換と移行時の欠損理由を定義する。

## 72. テスト戦略

pure unit、API mock、webhook integration、shell contract、prompt regression、target CI、control-plane CI を組み合わせる。

## 73. 回帰テスト方針

発生した障害は原因となった状態遷移や入力を再現するテストへ固定し、症状だけを抑える修正にしない。

## 74. 運用手順

webhook 起動、health check、cron、queue、cooldown、親再開、提出履歴、緊急停止を共通手順として文書化する。

## 75. 障害復旧手順

取り残し Issue、stale lock、重複 process、artifact 欠落、認証失敗を、読取確認から安全に復旧する順序を定める。

## 76. 設計上の不変条件

以下は実装方式にかかわらず維持しなければならない。

- Issue は原則一コミット単位になるまで再帰的に分解する。
- 子 Issue も必要なら親として、さらに子 Issue を作成する。
- 末端 Issue だけが直接実装し、非末端 Issue は直下成果を集約する。
- 親は全直下子の完了前に完了しない。
- 最終子 Issue は親の集約、PR、Kaggle 提出を代行しない。
- 完了は一階層ずつ上位へ伝播する。
- 未検証の Issue を Done にしない。
- 受け入れは品質ゲートと実挙動検証を通過した自動判定で行い、人間確認は定義された例外条件のみとする。
- exit 0 だけで成功と判定しない。
- webhook が欠落しても reaper により状態を収束させる。
- 無進捗の run は watchdog が検出し、無期限に放置しない。
- retry／resume は冪等であり、同じ出力への重複 writer を作らない。
- Kaggle 提出は最上位改善サイクル親だけが行う。
- Kaggle の一次 KPI は leaderboard スコアと順位であり、ローカル評価は代理指標として乖離を監視する。
- 非昇格が確定した改善軸は実験台帳に記録し、新しい根拠なしに再試行しない。
- 改善が飽和した lineage で人間を待って停止せず、戦略転換または資源再配分を先に行う。
- repository／lineage ごとの score、artifact、fingerprint を混同しない。
- 必要な background job が残る状態で完了報告しない。
- 外部認証や artifact 整合性を確認できない場合は安全側へ停止する。
- 人間の正当な Done、Canceled、Duplicate を自動処理で覆さない。

## 77. 既存文書との関係

この文書を設計索引とし、詳細仕様は次の既存文書へ委譲する。

- [Runner Queue](../runner-queue.md)
- [Webhook](../webhook.md)
- [Kaggle Submission](../kaggle-submission.md)
- [AI Pipeline Plan](../ai/10_plan.md)
- [AI Acceptance](../ai/40_acceptance.md)
- リポジトリルートの `CLAUDE.md`
- `config/` および `scripts/ai/` の実行設定

## 78. 設計変更手順

設計に影響する変更は、実装、回帰テスト、本設計文書、必要な運用文書を同じ変更単位で更新する。

変更レビューでは、少なくとも次を確認する。

1. 上記不変条件を破っていないか。
2. 新しい状態や失敗分類が文書化されているか。
3. 再起動、migration、運用への影響が明示されているか。
4. 実際の障害経路を再現する回帰テストがあるか。
5. Linear、GitHub、Kaggle の責務境界が維持されているか。
