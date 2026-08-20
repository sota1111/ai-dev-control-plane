/**
 * NEDO 積付アルゴリズム（SIGNATE スクリーニング）自動改善サイクル — 完了駆動の連続起票ドラフタ。
 *
 * sonnet_gold_cycle_draft.ts（signate-messy-drive-rag の完了駆動ループ）と同型:
 * cron は高頻度（10分毎）に本ドラフタを叩き、直列ガード（未完了の親があれば skip）と最小間隔だけで
 * 律速する。前サイクルの親 issue が完了すると、最初のチェックで次サイクルが自動起票される —
 * 「完了 → 採点（ローカル評価＋LB フィードバック）→ 改善提案 → 実装」が連続で回り続ける。
 * kaggle_improvement_cycle.sh の時刻グリッド枠（旧 0/12 JST pinned）はこのループへ置き換えた。
 *
 * KPI 階層:
 *   一次 = SIGNATE 公式 LB スコア（4成分加重平均・提出フィードバックに成分別スコアが返る）
 *   proxy = 公式シミュレータでの自作テストケース分布のローカル評価（fill は公式 evaluator、
 *           cog/placement/stability は README 定義の再実装 — 提出フィードバックと突き合わせ較正）
 *
 * oracle-drift ガード（SIGNATE rank-26 post-mortem）: ローカル proxy が天井付近で頭打ちなのに LB スコアが
 * 停滞/未計測なら、kaggle エンジンと同一の model 非依存バナー（detectOracleDrift/buildOracleDriftBanner）を
 * 本文冒頭へ挿入し、proxy 登攀を止めて評価器の再較正・テストケース分布の再設計を唯一の軸にさせる。
 *
 * 使い方:
 *   npx tsx scripts/ai/nedo_loading_cycle_draft.ts --only-scheduled   # cron 用
 *   npx tsx scripts/ai/nedo_loading_cycle_draft.ts --force            # 即時起票（ブートストラップ）
 *   npx tsx scripts/ai/nedo_loading_cycle_draft.ts --dry-run          # 起票せず本文を出力
 *
 * 停止: docs/ai/auto_logs/nedo_loading_cycle.stop を作成するか、crontab の行を削除。
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
  type OracleDriftSignal,
} from '../../src/lib/kaggleImprovement.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = 'nedo-loading-algo-claude';
const LABEL = 'nedo-loading-cycle';
const TITLE_TAG = '[NEDO-LOADING]';
const MIN_INTERVAL_MIN = Number(process.env.NEDO_LOADING_CYCLE_MIN_INTERVAL_MIN || '15');
const STATE_FILE = path.join(REPO_ROOT, 'docs/ai/auto_logs/nedo_loading_cycle_state.json');
const STOP_FILE = path.join(REPO_ROOT, 'docs/ai/auto_logs/nedo_loading_cycle.stop');
const TARGET_REPO = '/workspaces/nedo-loading-algo-claude';
const HISTORY_FILE = path.join(TARGET_REPO, 'docs/ai/loading_history.jsonl');
const DEADLINE = '2026-10-19 23:55 JST（スクリーニング提出期限）';
const SIGNATE_TASK_KEY = '54eb698257344d638111c73d49664ddb';

type State = { lastCycle: number; lastIssue?: string; lastCreatedAt?: string };

/** loading_history.jsonl の1エントリ（必要フィールドのみ・他は無視）。 */
interface LoadingHistoryEntry {
  cycle?: number;
  /** ローカル proxy: 自作テストケース分布での推定総合スコア（0-100想定）。 */
  local_score?: number;
  /** 一次KPI: SIGNATE LB スコア（提出フィードバックの総合値。未提出サイクルは省略可）。 */
  lb_score?: number;
}

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

function readHistoryEntries(n: number): LoadingHistoryEntry[] {
  try {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => {
      try {
        return JSON.parse(l) as LoadingHistoryEntry;
      } catch {
        return {} as LoadingHistoryEntry;
      }
    });
  } catch {
    return [];
  }
}

/** ローカル proxy スコアが「天井付近で頭打ち」とみなす床値の既定（0-100スケール想定）。 */
export const DEFAULT_LOCAL_SCORE_CEILING_FLOOR = 90;

/**
 * 台帳末尾から oracle-drift シグナルを導出する（純粋関数・sonnetGoldOracleDrift と同じ骨格）。
 * proxy = local_score（自作評価器）/ 真の一次KPI = lb_score（SIGNATE LB）。
 * ローカルが床値以上で連続頭打ち × LB が上昇していない（または未計測＝真feedback欠如）で発火する。
 */
export function deriveLoadingDriftSignal(
  entries: LoadingHistoryEntry[],
  opts?: { localCeilingFloor?: number }
): OracleDriftSignal | undefined {
  const floor =
    typeof opts?.localCeilingFloor === 'number' && Number.isFinite(opts.localCeilingFloor)
      ? opts.localCeilingFloor
      : DEFAULT_LOCAL_SCORE_CEILING_FLOOR;
  const withLocal = entries.filter(
    (e) => typeof e.local_score === 'number' && Number.isFinite(e.local_score)
  );
  if (withLocal.length < 2) return undefined;

  let stagnantCycles = 0;
  for (let i = withLocal.length - 1; i >= 0; i--) {
    if ((withLocal[i].local_score as number) >= floor) stagnantCycles += 1;
    else break;
  }
  const last = withLocal[withLocal.length - 1].local_score as number;
  const proxySaturated = stagnantCycles >= 1 && last >= floor;
  if (!proxySaturated) return undefined;

  const lbVals = withLocal
    .map((e) => e.lb_score)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const lbMoving = lbVals.length >= 2 && lbVals[lbVals.length - 1] - lbVals[0] > 0;
  if (lbMoving) return undefined;

  const hasLb = lbVals.length > 0;
  return {
    proxyKpiName: 'ローカル評価スコア（自作テストケース分布・proxy）',
    proxySaturated,
    trueKpiName: hasLb ? 'SIGNATE LB スコア' : 'SIGNATE LB スコア（未計測＝真feedback欠如）',
    trueKpiStagnant: true,
    stagnantCycles,
    detail: hasLb
      ? `local≈${last} が天井(${floor}+)で${stagnantCycles}サイクル頭打ち・LBスコアも停滞。ローカル評価器/テスト分布が実採点を代表していない可能性。`
      : `local≈${last} が天井(${floor}+)で${stagnantCycles}サイクル頭打ち。LBスコアが台帳に無く真feedbackが閉じていない — 提出してLBを測ること。`,
  };
}

const RESUME_MARKER = '<!-- auto-parent-resumed -->';

/**
 * ポーリング型の親再開リコンサイラ（sonnet_gold_cycle と同型・webhook 配信非依存）:
 * 「In Review の親 × 全子完了 × 再開マーカー無し」を検知して Todo へ再開する。
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
      if (!parent?.title?.startsWith(`${TITLE_TAG} `)) continue;
      const children: any[] = parent?.children?.nodes ?? [];
      if (children.length === 0) continue;
      const complete = (s: any) =>
        s?.type === 'completed' || s?.type === 'canceled' || (s?.name || '').toLowerCase() === 'in review';
      if (!children.every((c) => complete(c.state))) continue;
      const comments: any[] = parent?.comments?.nodes ?? [];
      if (comments.some((c) => (c?.body || '').includes(RESUME_MARKER))) continue;
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
          body: `${RESUME_MARKER}\n## 親Issue自動再開（統合フェーズ・ポーリング検知）\n\n全ての子Issueが完了したため、親を **Todo** に戻しました（cron リコンサイラによる再開 — webhook 配信非依存）。\n子issueを再作成せず、統合ローカル評価 → 提出判断（signate CLI）→ 台帳追記 → 申し送りコメント → 完了、の統合フェーズを実行してください。\n\n### 子Issue\n${childList}`,
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
 * 直列ガード: 進行中のサイクル親 issue（タイトルが TITLE_TAG で始まる非終端 issue）があれば返す。
 * 子 issue の状態は直接見ない（残留 In Review 子が次サイクルを永久ブロックした SOT-2663 の教訓）。
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
    const openParent = nodes.find((n) => (n?.title || '').startsWith(`${TITLE_TAG} `));
    return openParent?.identifier ?? null;
  } catch (err) {
    console.error(`findOpenCycleIssue failed: ${(err as any)?.message || err}`);
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
    ? `直近の台帳エントリ（docs/ai/loading_history.jsonl 最終行）:\n\`\`\`\n${history}\n\`\`\``
    : '台帳 docs/ai/loading_history.jsonl は未作成 → 本サイクルで基盤整備（下記【初回タスク】）から始める。';

  return `workers: solo=claude:fable, handoff=on${driftBanner}

TARGET_REPO=${TARGET_REPO}

## ミッション（常設・自動起票サイクル第${cycle}次）

**SIGNATE「NEDO Challenge コンテスト2: 積付アルゴリズム」スクリーニングの LB スコア（4成分加重平均）を最大化する。**
締切: ${DEADLINE}。本サイクルは**完了駆動**で連続起票される（前サイクル完了後、自動的に本issueが
起票された。本issueが完了すると次サイクルが自動起票される — 「完了→採点→改善提案→実装」が連続で回り続ける）。
${prevRef}

${historyBlock}

**必読**: \`${TARGET_REPO}/docs/ai/00_competition_context.md\`（コンペ仕様・評価指標・提出方法・確定/未確認事項）。

## 【KPI 階層】

- **一次KPI = SIGNATE 公式 LB スコア**。提出フィードバックに成分別スコア
  （fill/cog/stability/placement/soft/num_placed/処理時間）が返る — 必ず台帳に記録する。
- **proxy = 公式シミュレータでのローカル評価**（自作テストケース分布の平均）。fill は公式 evaluator、
  cog/placement/stability/soft は README の定義を逐語で再実装したもの（自作の近似規則を発明しない）。
  **proxy と LB が乖離したら LB を信じ、評価器/テスト分布を再較正する。**
- 加重平均の重みは非公開 — 提出ごとの成分スコア×LBスコアから回帰推定し、推定重みを台帳に残す。

## 【1サイクルの手順】（親=分析・分解・統合 / 子=並列実装）

1. **前回結果の採点分析と方針立案（Fable 必須・成果物化）**: 台帳・前回サイクルの申し送り・直近の
   ローカル評価結果（成分別）・LB フィードバックを読み、**弱い成分と失敗ケースを特定**する
   （どの成分が律速か / どのテストケース型で落ちるか / タイムアウト・積載未達=fill以外0 の有無）。
   分析結果と本サイクルの改善方針を \`docs/ai/cycle_analysis/cycle${cycle}.md\`（target repo 内）に保存する。
2. **子issueを 2〜5 件起票**: 分析から互いに独立な改善クラスタを選び、コミット単位の子issueへ分解して
   登録する。各子issueには必ず:
   - 冒頭に \`workers: solo=claude:opus, handoff=on\`
   - ラベル \`${LABEL}\` を付与（直列ガードが子の完了を待つために必須）
   - TARGET_REPO / 対象成分・ケース / 実装方針 / focused 検証（該当テストケースでのローカル評価）を明記
3. 子issue登録後、親はこの issue を **In Review にして待機**する（全子が完了すると自動で親が再開される）
4. **再開後（全子完了を確認してから）**: 統合ローカル評価（自作テストケース分布全体で run）→ 候補を
   選抜して **signate CLI で提出**する:
   \`signate submit --task_key ${SIGNATE_TASK_KEY} --path submit.zip --memo "cycle${cycle}: <候補名と変更概要>"\`
   - 提出前に評価基盤互換を必ず確認: agent.py/Agentクラス仕様・policy 8s/step・optimize 180s・
     メモリ12GB・**インターネット遮断**（外部接続コードが無いこと）・requirements.txt の妥当性
   - **提出予算 = 1日5回（JST日付基準）を使い切る**（ユーザー指示 2026-08-20）: ベスト候補に加え、
     性質の異なる候補（順序規則・配置規則・パラメータのバリエーション等）を同日予算の残りで追加提出
     してよい。提出ごとに成分別フィードバックが返るため、多様な候補の提出は評価器較正・重み回帰の
     アンカーを増やす。ただし**同一内容（同一 SHA-256）の再提出はしない**。
   - 日次カウント管理: 提出のたび \`docs/ai/submission_log.jsonl\` へ
     \`{"ts":"<UTC>","jst_date":"YYYY-MM-DD","cycle":${cycle},"sha256":"<zipのSHA-256>","candidate":"<名前>","memo":"..."}\`
     を追記し、**同一 JST 日付の行数が5を超える提出はしない**。プラットフォーム実上限が5未満と判明
     したらそれに従い、00_competition_context.md を更新する
5. \`docs/ai/loading_history.jsonl\` へ追記（1サイクル=1行）:
   \`{"cycle":${cycle},"ts":"<UTC>","local_score":N,"local_components":{"fill":N,"cog":N,"stability":N,"placement":N,"soft":N},"submitted":true|false,"lb_score":N,"lb_components":{...},"est_weights":{...},"changes":["..."],"next":["..."]}\`
   （未提出サイクルは lb_* を省略。**lb_score は oracle-drift 自動検知の真feedback入力** — 提出したら必ず記録）
6. 本 issue に結果サマリと**次サイクルへの申し送り**（子ごとの成果 / 成分別の伸び / 閉じた軸と証拠 /
   未検証仮説 / 次の候補）をコメントし、完了する

## 【初回タスク】（台帳が未作成の場合のみ — 本サイクルで基盤整備）

- (a) シミュレータ環境構築: \`data/simulator/\`（DL済み）を使い、README 記載のバージョンで \`.venv\` を作成
  （gymnasium==1.2.3 / pybullet==3.2.7 / pillow==10.3.0 / torch CPU）。\`scripts/run_test.py\` がサンプル
  エージェントで通ることを確認
- (b) 自作テストケース分布の設計: \`configs/item_params.xlsx\` の荷物種パラメータを基に、コンテナ数/寸法・
  荷物種構成・順序をばらした config 群（10ケース以上）を作成（特定ケースへの過適合防止のための評価母集団）
- (c) ローカル評価ハーネス: 公式 evaluator（fill）＋ cog/placement/stability/soft の README 定義準拠の
  再実装。評価結果を成分別 JSON で出す
- (d) ベースライン agent 実装（貪欲配置: 大きい順・壁詰め等の単純則）→ ローカル評価 → **初回提出**で
  LB フィードバックを取得 → 台帳へ cycle ${cycle} として記録（成分別ローカル値と LB 値の突き合わせが
  評価器較正の最初のアンカーになる）

## 【ガードレール】

- **評価基盤互換が最優先**: タイムアウト超過は fallback（optimize=元順序 / policy=ランダム配置）で
  実質減点になる。ローカルで制限時間の 1秒以上手前で動くことを確認してから提出する
- **一定数以上積載できないと fill 以外 0** — 積載完遂を最優先の制約として扱う
- 特定テストケースへの過適合禁止（評価は必ず分布平均で判断）。テストケース/gold値のハードコード禁止
- 提出は signate CLI のみ（kaggle CLI・kaggle_targets_submit.sh は使わない — このコンペは SIGNATE）
- **人間コメント尊重（newest-wins）**: (a) 子issue分解の直前、(b) 再開後の統合評価の直前に、本 issue の
  コメントを再取得し、人間の新しい指示があれば最新を優先する
- **oracle-drift 監視（自動）**: ローカル proxy が天井付近で頭打ちなのに LB が停滞/未計測と判定されると、
  本文冒頭に 🔻 再アンカー指令が自動挿入される。挿入時は proxy 登攀を止め、**評価器の再較正と
  テストケース分布の再設計**を唯一の軸にする
- 1サイクル直列（親と全子が完了するまで次の自動起票は抑止される）
- 停止方法: \`docs/ai/auto_logs/nedo_loading_cycle.stop\` を作成（control-plane 側）

## 受け入れ条件

- [ ] ローカル評価（テストケース分布）を実施し成分別スコアを記録した
- [ ] 提出した場合: LB フィードバック（成分別）を台帳へ記録した / 未提出の場合: 理由を台帳へ記録した
- [ ] 台帳追記＋次サイクルへの申し送りコメント
`;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const onlyScheduled = args.has('--only-scheduled');
  const force = args.has('--force');
  const dryRun = args.has('--dry-run');
  const skipGuard = args.has('--skip-guard');

  configureLinearApi({
    log: (tag, message) => console.error(`[${tag}] ${message}`),
    linearApiUrl: 'https://api.linear.app/graphql',
    longRunLabel: 'long-run',
    removeFromQueue: () => {},
  });

  const result: Record<string, unknown> = { at: new Date().toISOString() };

  if (fs.existsSync(STOP_FILE)) {
    console.log(JSON.stringify({ ...result, action: 'skip', reason: 'stop file present' }));
    return;
  }
  if ((process.env.NEDO_LOADING_CYCLE_ENABLED || '1') === '0') {
    console.log(JSON.stringify({ ...result, action: 'skip', reason: 'disabled by env' }));
    return;
  }
  // 完了駆動: 時刻ゲート無し。最小間隔（前回起票からの経過）だけを確認する（起票スラッシング防止）。
  if (onlyScheduled && !force) {
    const last = readState().lastCreatedAt ? Date.parse(readState().lastCreatedAt as string) : 0;
    const elapsedMin = (Date.now() - last) / 60000;
    if (last > 0 && elapsedMin < MIN_INTERVAL_MIN) {
      console.log(JSON.stringify({ ...result, action: 'skip', reason: `min interval: ${elapsedMin.toFixed(1)}min < ${MIN_INTERVAL_MIN}min` }));
      return;
    }
  }

  const resumed = await reconcileStalledParent(PROJECT, LABEL);
  if (resumed) {
    console.log(JSON.stringify({ ...result, action: 'resumed-parent', issue: resumed }));
    return;
  }

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
  const driftSignal = deriveLoadingDriftSignal(
    readHistoryEntries(DEFAULT_ORACLE_DRIFT_ESCALATE_CYCLES + 2),
    Number(process.env.NEDO_LOADING_DRIFT_CEILING)
      ? { localCeilingFloor: Number(process.env.NEDO_LOADING_DRIFT_CEILING) }
      : undefined
  );
  const driftResult = detectOracleDrift(driftSignal);
  const driftBanner = buildOracleDriftBanner(driftSignal, driftResult);
  const title = `${TITLE_TAG} 積付アルゴリズム改善サイクル第${cycle}次（LBスコア最大化）`;
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error('nedo_loading_cycle_draft failed:', err?.message || err);
    process.exitCode = 1;
  });
}
