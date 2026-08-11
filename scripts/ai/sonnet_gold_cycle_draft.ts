/**
 * Sonnet local gold100 自動改善サイクル — 4時間毎の定期起票ドラフタ。
 *
 * 目的: signate-messy-drive-rag の「Sonnet(claude-mcp) dev gold100 の net」を KPI とする改善
 * サイクル Issue を JST 4時間グリッドで起票する。回答実行は Sonnet のみ（Gemini は前処理限定）、
 * 第1目標 = abstain を前処理で 0 に、その後 wrong 削減 — の常設指示をテンプレートに埋め込む。
 *
 * 設計は kaggle_improvement_cycle.sh と同型（毎時 cron → 本スクリプトが JST 時刻・直列ガードを
 * 判定して起票）。既存コードは変更せず linearApi の createDraftIssue / findOpenAutoImproveIssue を
 * 流用する standalone スクリプト。
 *
 * 使い方:
 *   npx tsx scripts/ai/sonnet_gold_cycle_draft.ts --only-scheduled   # cron 用（JSTグリッド時のみ）
 *   npx tsx scripts/ai/sonnet_gold_cycle_draft.ts --force            # 即時起票（ブートストラップ）
 *   npx tsx scripts/ai/sonnet_gold_cycle_draft.ts --dry-run          # 起票せず本文を出力
 *
 * 停止: docs/ai/auto_logs/sonnet_gold_cycle.stop を作成するか、crontab の行を削除。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  configureLinearApi,
  createDraftIssue,
  findOpenAutoImproveIssue,
} from '../../src/lib/linearApi.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = 'signate-messy-drive-rag';
const LABEL = 'sonnet-gold-cycle';
/** JST 4時間グリッド。kaggle 枠 (0/6/12/18) との同時刻起票を避けてずらしてある。 */
const SCHEDULE_HOURS_JST = [1, 5, 9, 13, 17, 21];
const STATE_FILE = path.join(REPO_ROOT, 'docs/ai/auto_logs/sonnet_gold_cycle_state.json');
const STOP_FILE = path.join(REPO_ROOT, 'docs/ai/auto_logs/sonnet_gold_cycle.stop');
const TARGET_REPO = '/workspaces/signate-messy-drive-rag';
const HISTORY_FILE = path.join(TARGET_REPO, 'docs/ai/sonnet_gold_history.jsonl');

type State = { lastCycle: number; lastIssue?: string; lastCreatedAt?: string };

function readState(): State {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { lastCycle: 0 };
  }
}

function lastHistoryLine(): string | null {
  try {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n');
    return lines.length ? lines[lines.length - 1] : null;
  } catch {
    return null;
  }
}

function jstHour(): number {
  return (new Date().getUTCHours() + 9) % 24;
}

function buildDescription(cycle: number, state: State, history: string | null): string {
  const prevRef = state.lastIssue
    ? `前回サイクル: ${state.lastIssue}（申し送りコメントを必ず読むこと）`
    : '前回サイクル: なし（本サイクルが初回）';
  const historyBlock = history
    ? `直近の台帳エントリ（docs/ai/sonnet_gold_history.jsonl 最終行）:\n\`\`\`\n${history}\n\`\`\``
    : '台帳 docs/ai/sonnet_gold_history.jsonl は未作成 → 本サイクルで基盤整備（下記【初回タスク】）から始める。';

  return `workers: solo=claude:fable, handoff=on

TARGET_REPO=${TARGET_REPO}（\`.venv\` 必須）

## ミッション（常設・自動起票サイクル第${cycle}次）

**Sonnet local gold100 の net（match−wrong）を最大化する。** 4時間毎に本サイクルが自動起票される。
${prevRef}

${historyBlock}

## 【絶対制約】Gemini を実行しない

- 回答実行は **\`RAG_INVESTIGATOR_BACKEND=claude-mcp\`（Sonnet）のみ**。gold100 実行の前後で Gemini 課金が **$0** であることを機械確認し報告する。
- vision 等 genai を要する処理を回答時に行わない。**前処理（index ビルド・事前計算ストア構築）に限り Gemini 使用可**（ビルドで一度だけ実行し、結果を決定論ストアに焼き込む）。
- no-Gemini ガード（例: \`RAG_FORBID_GEMINI=1\` で回答実行中の genai 呼び出しを即例外にする）が未実装なら、本サイクルの最優先タスクとして実装する。
- judge は codex（従来どおり）。公式レーン（flash champion・公式 gold100・LB 提出）には一切触れない。全結果 **official:false**。

## 【方針】第1目標: abstain → 0 を「前処理」で達成。その後 wrong 削減

1. **abstain の消し込み（現行目標）**: 台帳と前回結果から棄権 idx を列挙し、各棄権の「欠落している証拠」を特定 → **事前計算事実層**（案件マスタ / IDマスタ逆引き / 派生メトリクス / 版ペア差分 = SOT-2643〜2647 の資産。未整備部分は本サイクルで実装してよい）の**質問非依存カバレッジ拡張**で証拠をストアに用意し、lookup で到達させる。
   - **無理な回答化はしない**: 証拠をストアに用意できない問いは棄権のまま残す（precision 崩壊の既知失敗: cycle2 net28 / Sonnet wrong28）。
2. **wrong の削減（abstain ≤ 5 到達後）**: commit_gate（SOT-2637/2640 実装済み）の締め直し・書式契約（括弧内付加情報クラス等）・codex judge の3回多数決化・per-idx focused 修正。

## 【1サイクルの手順】

1. 台帳・前回サイクル issue の申し送り・\`docs/ai/champion_abstain_wrong_classification.md\` を読む
2. 上位の棄権 2〜4 件を対象に、コミット単位で実装（前処理ストア拡張＋lookup 配線が主軸）
3. focused 検証: \`scripts/run_focused_gate.py --dev\`（Sonnet 番兵つき・official:false 刻印）で対象改善＋番兵回帰ゼロを確認
4. **Sonnet dev gold100 を1回実行**（claude-mcp・並列1・resume 対応）。usage limit 逼迫を検知したら gold100 はスキップし前処理のみで完了とし、その旨を申し送りに記録
5. \`docs/ai/sonnet_gold_history.jsonl\` へ追記: \`{"cycle":${cycle},"ts":"<UTC>","match":N,"abstain":N,"wrong":N,"net":N,"gemini_cost_usd":0,"changes":["..."],"skipped_gold":false,"next":["..."]}\`
6. 本 issue に結果サマリと**次サイクルへの申し送り**をコメントし、通常ライフサイクル（PR→merge→In Review）で完了する

## 【初回タスク】（台帳が未作成の場合のみ）

- (a) no-Gemini ガード \`RAG_FORBID_GEMINI\` の実装（回答実行中の genai 呼び出しで即例外・既定OFF）
- (b) Sonnet 番兵セットの選定（Sonnet 安定 MATCH から型横断10問、\`run_focused_gate.py --dev\` で使う）
- (c) 台帳 \`docs/ai/sonnet_gold_history.jsonl\` の新設
- (d) baseline の Sonnet dev gold100 を1回実行して cycle 0 として記録（直近実測: net 16〜18 / match 46 / abstain 26 / wrong 28 級）

## 【ガードレール】

- gold 値のハードコード禁止。事前計算は**質問を見ない網羅計算**のみ（全案件×全属性/全ID/全標準メトリクス/全版ペア）
- serve path 変更はフラグゲート・既定OFF（dev 構成で ON にして測る）。OFF時 byte-identical
- 官式資産（flash champion 構成・公式 history・LB 提出・SIGNATE CLI）に触れない
- **担当の役割分担**: 本サイクル親issueは Fable（\`solo=claude:fable\`）が処理する。作業を分割して**子issueを起票する場合は、子issueの説明冒頭に必ず \`workers: solo=claude:opus, handoff=on\` を記載**する（親=Fable が判断と統合、子=opus が実装）。子issueには TARGET_REPO・focused検証（番兵つき）・Gemini禁止の制約を継承させること
- 1サイクル1issue・直列（本サイクル未完了中は次の自動起票が抑止される）
- 停止方法: \`docs/ai/auto_logs/sonnet_gold_cycle.stop\` を作成（control-plane 側）

## 受け入れ条件

- [ ] Gemini 課金 $0 の確認（または gold100 スキップの明記）
- [ ] 対象棄権の focused 改善＋Sonnet 番兵回帰ゼロ
- [ ] 台帳追記＋次サイクルへの申し送りコメント
`;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const onlyScheduled = args.has('--only-scheduled');
  const force = args.has('--force');
  const dryRun = args.has('--dry-run');

  configureLinearApi({
    log: (tag, message) => console.error(`[${tag}] ${message}`),
    linearApiUrl: 'https://api.linear.app/graphql',
    longRunLabel: 'long-run',
    removeFromQueue: () => {},
  });

  const result: Record<string, unknown> = { at: new Date().toISOString(), jstHour: jstHour() };

  if (fs.existsSync(STOP_FILE)) {
    console.log(JSON.stringify({ ...result, action: 'skip', reason: 'stop file present' }));
    return;
  }
  if ((process.env.SONNET_GOLD_CYCLE_ENABLED || '1') === '0') {
    console.log(JSON.stringify({ ...result, action: 'skip', reason: 'disabled by env' }));
    return;
  }
  if (onlyScheduled && !SCHEDULE_HOURS_JST.includes(jstHour())) {
    console.log(JSON.stringify({ ...result, action: 'skip', reason: 'not a scheduled JST hour' }));
    return;
  }

  // 直列ガード: 未完了（Todo / In Progress）の同ラベル issue があれば起票しない。
  const open = await findOpenAutoImproveIssue(PROJECT, LABEL);
  if (open) {
    console.log(JSON.stringify({ ...result, action: 'skip', reason: `open cycle issue: ${open}` }));
    return;
  }

  const state = readState();
  const cycle = (state.lastCycle || 0) + 1;
  const history = lastHistoryLine();
  const title = `[SONNET-GOLD] sonnet local gold100 改善サイクル第${cycle}次（abstain→0を前処理で）`;
  const description = buildDescription(cycle, state, history);

  if (dryRun) {
    console.log(JSON.stringify({ ...result, action: 'dry-run', cycle, title }));
    console.log('----- description -----');
    console.log(description);
    return;
  }

  const created = await createDraftIssue({ projectName: PROJECT, title, description, labelName: LABEL });
  if (!created) {
    console.log(JSON.stringify({ ...result, action: 'error', reason: 'createDraftIssue returned null' }));
    process.exitCode = 1;
    return;
  }
  const next: State = { lastCycle: cycle, lastIssue: created.identifier, lastCreatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, action: 'created', cycle, issue: created.identifier, url: created.url }));
}

main().catch((err) => {
  console.error('sonnet_gold_cycle_draft failed:', err?.message || err);
  process.exitCode = 1;
});
