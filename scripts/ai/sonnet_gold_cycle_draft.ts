/**
 * Sonnet local gold100 自動改善サイクル — 完了駆動の連続起票ドラフタ（前サイクル完了→次を即起票）。
 *
 * 目的: signate-messy-drive-rag の「Sonnet(claude-mcp) dev gold100 の net」を KPI とする改善
 * サイクル Issue を JST 4時間グリッドで起票する。回答実行は Sonnet のみ（Gemini は前処理限定）、
 * 第1目標 = abstain を前処理で 0 に、その後 wrong 削減 — の常設指示をテンプレートに埋め込む。
 *
 * oracle-drift ガード（SIGNATE rank-26 post-mortem）: net は「我々の手動 gold との一致度」＝自己参照 proxy で、
 * gold 自体の真値精度 ~88.5% が天井。proxy を net99 まで上げても真値は停滞したのに機構は re-anchor しなかった。
 * 本ドラフタは台帳末尾から proxy 飽和×真KPI停滞を検知し（`deriveOracleDriftSignalFromHistory`）、drift 時は
 * kaggle エンジンと**同一の model 非依存バナー**（`detectOracleDrift`/`buildOracleDriftBanner`）を本文冒頭へ挿入
 * する。どの worker（fable/opus/codex/gpt）が処理しても同じ再アンカー指令が効く。
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
  linearQuery,
} from '../../src/lib/linearApi.js';
import {
  detectOracleDrift,
  buildOracleDriftBanner,
  DEFAULT_ORACLE_DRIFT_ESCALATE_CYCLES,
} from '../../src/lib/kaggleImprovement.js';
import {
  deriveOracleDriftSignalFromHistory,
  type GoldHistoryEntry,
} from '../../src/lib/sonnetGoldOracleDrift.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = 'signate-messy-drive-rag';
const LABEL = 'sonnet-gold-cycle';
/**
 * 完了駆動の連続サイクル（2026-08-12 ユーザー指示で時刻グリッドから変更）:
 * cron は高頻度（10分毎）に本ドラフタを叩き、直列ガード（未完了の親/子があれば skip）と
 * 最小間隔だけで律速する。前サイクル完了後、最初のチェックで次サイクルが起票される。
 * 最小間隔（既定15分）は即死ループ時の起票スラッシング防止。
 */
const MIN_INTERVAL_MIN = Number(process.env.SONNET_GOLD_CYCLE_MIN_INTERVAL_MIN || '15');
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

/** 台帳末尾 n 件を parse して返す（oracle-drift 判定用）。読めない/壊れた行は空オブジェクト。 */
function readHistoryEntries(n: number): GoldHistoryEntry[] {
  try {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => {
      try {
        return JSON.parse(l) as GoldHistoryEntry;
      } catch {
        return {} as GoldHistoryEntry;
      }
    });
  } catch {
    return [];
  }
}

function jstHour(): number {
  return (new Date().getUTCHours() + 9) % 24;
}

const RESUME_MARKER = '<!-- auto-parent-resumed -->';

/**
 * ポーリング型の親再開リコンサイラ（2026-08-12 追加）:
 * Linear webhook の HTTP 配信が環境によって届かない（受信ログゼロの実障害 — SOT-2651/2662 が
 * 子完了後も In Review で停滞）ため、webhook 配信に依存せず、この 10 分毎 tick で
 * 「In Review の SONNET-GOLD 親 × 全子完了 × 再開マーカー無し」を検知して Todo へ再開する。
 * webhook 側の finalizeParent と冪等（マーカーで相互にスキップ）。
 */
async function reconcileStalledParent(projectName: string, labelName: string): Promise<string | null> {
  try {
    const data: any = await linearQuery(
      `query($name: String!, $label: String!) {
        issues(filter: {
          project: { name: { eq: $name } },
          labels: { name: { eq: $label } },
          state: { name: { eq: "In Review" } }
        }, first: 5) {
          nodes {
            id identifier title
            team { id }
            children(first: 50) { nodes { identifier state { name type } } }
            comments(first: 50) { nodes { body } }
          }
        }
      }`,
      { name: projectName, label: labelName }
    );
    const nodes: any[] = data?.issues?.nodes ?? [];
    for (const parent of nodes) {
      if (!/^\[SONNET-GOLD\] /.test(parent?.title || '')) continue;
      const children: any[] = parent?.children?.nodes ?? [];
      if (children.length === 0) continue;
      const complete = (s: any) =>
        s?.type === 'completed' || s?.type === 'canceled' || (s?.name || '').toLowerCase() === 'in review';
      if (!children.every((c) => complete(c.state))) continue;
      const comments: any[] = parent?.comments?.nodes ?? [];
      // 先頭一致で判定する（完了報告がマーカー文字列を逐語引用しても誤検知しない。finalizeParent の
      // SOT-2773 恒久滞留と同型のバグを防ぐ）。
      if (comments.some((c) => (c?.body || '').trimStart().startsWith(RESUME_MARKER))) continue;
      // Todo state を解決して再開。
      const st: any = await linearQuery(
        'query($teamId: ID!) { workflowStates(filter: { team: { id: { eq: $teamId } }, type: { eq: "unstarted" } }) { nodes { id name } } }',
        { teamId: parent.team.id }
      );
      const states: any[] = st?.workflowStates?.nodes ?? [];
      const todo = states.find((s) => (s?.name || '').toLowerCase() === 'todo') ?? states[0];
      if (!todo?.id) continue;
      await linearQuery(
        'mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }',
        { id: parent.id, stateId: todo.id }
      );
      const childList = children.map((c) => `- ${c.identifier} (${c.state?.name})`).join('\n');
      await linearQuery(
        'mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }',
        {
          issueId: parent.id,
          body: `${RESUME_MARKER}\n## 親Issue自動再開（統合フェーズ・ポーリング検知）\n\n全ての子Issueが完了したため、親を **Todo** に戻しました（cron リコンサイラによる再開 — webhook 配信非依存）。\n子issueを再作成せず、統合 focused → Sonnet dev gold100 ×1 → 台帳追記 → 申し送りコメント → 完了、の統合フェーズを実行してください。\n\n### 子Issue\n${childList}`,
        }
      );
      return parent.identifier;
    }
    return null;
  } catch (err) {
    console.error(`reconcileStalledParent failed: ${(err as any)?.message || err}`);
    return null;
  }
}

/**
 * 直列ガード: 進行中の**サイクル本体（親 issue）**があれば返す（無ければ null）。
 *
 * サイクルは「[SONNET-GOLD] 親 issue」で定義される。親が非終端（Todo/In Progress/In Review=子待ち）
 * の間だけ次サイクルを止める。**子 issue の状態は直接見ない** — 親が Done になった後に残留した
 * In Review の子（rejected 軸で auto-accept されなかった等）が次サイクルを永久ブロックしていた実障害
 * （2026-08-12 SOT-2663）の恒久修正。親が Done なら統合測定まで完了済み＝子は全て完了しているので、
 * 残留子で塞ぐ必要はない。ラベルは親子共通のため、タイトルの [SONNET-GOLD] で親だけに絞る。
 */
async function findOpenCycleIssue(projectName: string, labelName: string): Promise<string | null> {
  try {
    const data: any = await linearQuery(
      `query($name: String!, $label: String!) {
        issues(filter: {
          project: { name: { eq: $name } },
          labels: { name: { eq: $label } },
          state: { name: { in: ["Todo", "In Progress", "In Review"] } }
        }, first: 20) { nodes { identifier title } }
      }`,
      { name: projectName, label: labelName }
    );
    const nodes: any[] = data?.issues?.nodes ?? [];
    const openParent = nodes.find((n) => /^\[SONNET-GOLD\] /.test(n?.title || ''));
    return openParent?.identifier ?? null;
  } catch (err) {
    console.error(`findOpenCycleIssue failed: ${(err as any)?.message || err}`);
    // ガード照会の失敗は安全側（起票しない）に倒す。
    return 'guard-query-failed';
  }
}

function buildDescription(
  cycle: number,
  state: State,
  history: string | null,
  driftBanner: string
): string {
  const prevRef = state.lastIssue
    ? `前回サイクル: ${state.lastIssue}（申し送りコメントを必ず読むこと）`
    : '前回サイクル: なし（本サイクルが初回）';
  const historyBlock = history
    ? `直近の台帳エントリ（docs/ai/sonnet_gold_history.jsonl 最終行）:\n\`\`\`\n${history}\n\`\`\``
    : '台帳 docs/ai/sonnet_gold_history.jsonl は未作成 → 本サイクルで基盤整備（下記【初回タスク】）から始める。';

  // oracle-drift（net proxy 飽和×真KPI停滞）時は本文冒頭へ強制再アンカー指令を差し込む。kaggle エンジンと
  // 同一の model 非依存バナー — どの worker（fable/opus/codex/gpt）が処理しても同じガードが効く。
  return `workers: solo=claude:fable, handoff=on${driftBanner}

TARGET_REPO=${TARGET_REPO}（\`.venv\` 必須）

## ミッション（常設・自動起票サイクル第${cycle}次）

**Sonnet local gold100 の net（match−wrong）を最大化する。** 本サイクルは**完了駆動**で連続起票される（前サイクル完了後、自動的に本issueが起票された。本issueが完了すると次サイクルが自動起票される — 改善は連続で回り続ける）。
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

## 【1サイクルの手順】（親=分析・分解・統合 / 子=並列実装 — 1サイクルで複数の改善を進める）

1. **前回結果の失敗調査と方針立案（Fable 必須・成果物化）**: 台帳・前回サイクルの申し送り・直近 Sonnet gold100 の
   details/abstain_ledger を読み、**abstain/wrong を per-idx で全数分類**する（state code × 契約型 ×
   欠落証拠の特定 × 過去実測での到達実績のクロス）。**失敗の帰属は証拠つきで行う**（前サイクルの
   変更が原因と疑う場合はテレメトリ/ツール列で確認し、単発揺らぎと区別する。証拠なき帰属で軸を
   閉じない）。分析結果と本サイクルの方針を
   \`docs/ai/sonnet_cycle_analysis/cycle${cycle}.md\` に保存する（次サイクルの一次入力になる）
2. **子issueを 3〜6 件起票（必須）**: 分類から**互いに独立な改善クラスタを 3〜6 件**選び、
   コミット単位の子issueへ分解して登録する（合計で 8〜15 idx を対象にする — 1サイクルの改善量を
   最大化する）。各子issueには必ず:
   - 冒頭に \`workers: solo=claude:opus, handoff=on\`
   - ラベル \`sonnet-gold-cycle\` を付与（直列ガードが子の完了を待つために必須）
   - TARGET_REPO / 対象 idx / 欠落証拠と実装方針 / focused 検証（\`run_focused_gate.py --dev\`＋Sonnet番兵）/
     Gemini 禁止 / gold値ハードコード禁止 を明記（子は gold100 全量を回さない）
3. 子issue登録後、親はこの issue を **In Review にして待機**する（全子が完了すると webhook が親を
   再開する — 再開まで gold100 は実行しない）
4. **再開後（全子完了を確認してから）**: 統合 focused（全子の対象idx＋番兵）→ **Sonnet dev gold100 を
   1回実行**（claude-mcp・並列1・resume 対応・Gemini $0 確認）。usage limit 逼迫時は gold100 をスキップし
   その旨を記録
5. \`docs/ai/sonnet_gold_history.jsonl\` へ追記: \`{"cycle":${cycle},"ts":"<UTC>","match":N,"abstain":N,"wrong":N,"net":N,"gemini_cost_usd":0,"changes":["..."],"skipped_gold":false,"next":["..."]}\`
   - **可能なら \`"true_net":N\`（厳格判定/held-out probe の net＝真feedback）も記録する**。net(自己参照 proxy)と
     独立な真値KPIを台帳に残すことで、次サイクルの oracle-drift 自動検知が「proxy 飽和×真値停滞」を判定できる
     （真値KPIが無いと proxy が天井付近で頭打ちした時点で自動的に再アンカーが促される）。
6. 本 issue に結果サマリと**次サイクルへの申し送り**（子ごとの成果 / 閉じた軸と証拠 / 未検証仮説 /
   次の候補クラスタ）をコメントし、完了する

## 【初回タスク】（台帳が未作成の場合のみ）

- (a) no-Gemini ガード \`RAG_FORBID_GEMINI\` の実装（回答実行中の genai 呼び出しで即例外・既定OFF）
- (b) Sonnet 番兵セットの選定（Sonnet 安定 MATCH から型横断10問、\`run_focused_gate.py --dev\` で使う）
- (c) 台帳 \`docs/ai/sonnet_gold_history.jsonl\` の新設
- (d) baseline の Sonnet dev gold100 を1回実行して cycle 0 として記録（直近実測: net 16〜18 / match 46 / abstain 26 / wrong 28 級）

## 【ガードレール】

- gold 値のハードコード禁止。事前計算は**質問を見ない網羅計算**のみ（全案件×全属性/全ID/全標準メトリクス/全版ペア）
- serve path 変更はフラグゲート・既定OFF（dev 構成で ON にして測る）。OFF時 byte-identical
- 官式資産（flash champion 構成・公式 history・LB 提出・SIGNATE CLI）に触れない
- **担当の役割分担**: 親issue（本issue）= Fable（\`solo=claude:fable\`）が分析・分解・統合を担当。**子issue = opus**（説明冒頭に必ず \`workers: solo=claude:opus, handoff=on\`）が実装を並列に担当。子issueには TARGET_REPO・focused検証（番兵つき）・Gemini禁止の制約を継承させ、**ラベル \`sonnet-gold-cycle\` を必ず付与**する
- 1サイクル直列（親と全子が完了するまで次の自動起票は抑止される）。gold100 全量はサイクル末の親の1回のみ（子は focused のみ）
- **人間コメント尊重（newest-wins）**: (a) 子issue分解の直前、(b) 再開後の統合測定の直前に、本 issue のコメントを再取得し、人間の新しい指示があれば最新を優先する
- **oracle-drift 監視（自動・SIGNATE rank-26 post-mortem）**: net（自己参照 proxy）が天井付近で頭打ちなのに
  独立な真値KPI（\`true_net\`）が動かない/無いと判定されると、本文冒頭に **🔻 ORACLE DRIFT 再アンカー指令**が
  自動挿入される。挿入時は net 最大化・per-idx回収を止め、**gold（オラクル）の真値妥当性の独立再検証**を唯一の軸に
  する（proxy を99まで上げても真値88.5%停滞だった実事故の再発防止）。この判定は model 非依存で、どの worker が
  処理しても同じく効く。
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
  // 手動ブートストラップ用: 直列ガードを明示的に無視して起票する（cron では使わない）。
  const skipGuard = args.has('--skip-guard');

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
  // 完了駆動モード: 時刻ゲートは廃止。最小間隔（前回起票からの経過）だけを確認する。
  if (onlyScheduled && !force) {
    const last = readState().lastCreatedAt ? Date.parse(readState().lastCreatedAt as string) : 0;
    const elapsedMin = (Date.now() - last) / 60000;
    if (last > 0 && elapsedMin < MIN_INTERVAL_MIN) {
      console.log(JSON.stringify({ ...result, action: 'skip', reason: `min interval: ${elapsedMin.toFixed(1)}min < ${MIN_INTERVAL_MIN}min` }));
      return;
    }
  }

  // ポーリング型リコンサイラ: 子待ち停滞中の親（In Review×全子完了×マーカー無し）を先に再開する。
  const resumed = await reconcileStalledParent(PROJECT, LABEL);
  if (resumed) {
    console.log(JSON.stringify({ ...result, action: 'resumed-parent', issue: resumed }));
    return; // 再開した親が実行されるのが先 — 起票はしない。
  }

  // 直列ガード: 未完了の同ラベル issue（親またはその子）があれば起票しない。親が子待ちで
  // In Review に滞在する設計（複数子issue並列実装）のため、In Review も「未完了」に含める
  // （完了した親は auto-accept が Done へ促進するので、In Review 滞留は原則一時的）。
  const open = await findOpenCycleIssue(PROJECT, LABEL);
  if (open && !skipGuard) {
    console.log(JSON.stringify({ ...result, action: 'skip', reason: `open cycle issue: ${open}` }));
    return;
  }
  if (open && skipGuard) {
    console.error(`WARNING: serial guard bypassed (--skip-guard); open cycle issue: ${open}`);
  }

  const state = readState();
  const cycle = (state.lastCycle || 0) + 1;
  const history = lastHistoryLine();
  // oracle-drift: 台帳末尾から net proxy 飽和×真KPI停滞を判定し、drift なら再アンカー指令バナーを本文へ挿入。
  const driftSignal = deriveOracleDriftSignalFromHistory(
    readHistoryEntries(DEFAULT_ORACLE_DRIFT_ESCALATE_CYCLES + 2),
    Number(process.env.SONNET_GOLD_DRIFT_NET_CEILING)
      ? { netCeilingFloor: Number(process.env.SONNET_GOLD_DRIFT_NET_CEILING) }
      : undefined
  );
  const driftResult = detectOracleDrift(driftSignal);
  const driftBanner = buildOracleDriftBanner(driftSignal, driftResult);
  const title = `[SONNET-GOLD] sonnet local gold100 改善サイクル第${cycle}次（abstain→0を前処理で）`;
  const description = buildDescription(cycle, state, history, driftBanner);

  if (dryRun) {
    console.log(
      JSON.stringify({ ...result, action: 'dry-run', cycle, title, oracleDrift: driftResult.level })
    );
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
  console.log(
    JSON.stringify({
      ...result,
      action: 'created',
      cycle,
      issue: created.identifier,
      url: created.url,
      oracleDrift: driftResult.level,
    })
  );
}

main().catch((err) => {
  console.error('sonnet_gold_cycle_draft failed:', err?.message || err);
  process.exitCode = 1;
});
