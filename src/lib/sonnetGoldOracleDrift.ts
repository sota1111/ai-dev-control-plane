/**
 * SIGNATE Sonnet gold100 net-cycle の oracle-drift 検知（SIGNATE rank-26 post-mortem）。
 *
 * sonnet_gold_cycle_draft.ts は「Sonnet local gold100 の net（match−wrong）を最大化する」を唯一のKPIに
 * していた。だが net は **自己参照 proxy**（我々の手動 gold との一致度）で、gold 自体の真値精度は ~88.5% が
 * 天井だった。proxy を net99 まで上げても真値は停滞したまま — にもかかわらず機構は re-anchor せず盲目登攀した。
 *
 * ここは、その net-cycle の台帳（sonnet_gold_history.jsonl）末尾から oracle-drift シグナルを **決定論的に**
 * 導出する純粋関数。判定ロジック本体（両条件必須・閾値・バナー生成）は kaggle エンジンと共有する
 * (`detectOracleDrift` / `buildOracleDriftBanner`)。**モデル非依存** — どの worker（fable/opus/codex/gpt）が
 * 処理しても同一のガードが本文に載る。
 */
import type { OracleDriftSignal } from './kaggleImprovement.js';

/** sonnet_gold_history.jsonl の1エントリ（必要フィールドのみ・他は無視）。 */
export interface GoldHistoryEntry {
  cycle?: number;
  net?: number;
  match?: number;
  wrong?: number;
  /** 独立な真値KPI（厳格判定 / held-out probe の net）。あれば「真feedback」として使う。 */
  true_net?: number;
  /** 独立な真値精度（true_net と同義に扱う。0-1 でも 0-100 でも単調性だけ見る）。 */
  true_accuracy?: number;
}

/** net（proxy）が「天井付近で頭打ち」とみなす床値の既定。net は match−wrong（~100満点）。 */
export const DEFAULT_SONNET_NET_CEILING_FLOOR = 90;

/**
 * 台帳末尾エントリ列から oracle-drift シグナルを導出する（純粋関数）。
 *
 * - proxy = 自己参照 net。末尾から連続して床値(既定90)以上のサイクル数を `stagnantCycles` とし、
 *   1以上かつ最新も床値以上なら `proxySaturated=true`（天井付近で頭打ち）。
 * - 真の一次KPI = 独立な真値KPI（`true_net`/`true_accuracy`）。window 内で上昇していれば「動いている」＝
 *   `trueKpiStagnant=false`。**台帳に真値KPIが無い場合は真feedback欠如として stagnant 扱い**（proxy を
 *   天井まで上げても真値を代表しない SIGNATE net99×真値88.5% の型）。
 * - 両立時のみ signal を返す。判定材料不足（net 観測 < 2）や proxy 未飽和なら undefined（従来挙動）。
 *
 * `stagnantCycles` は `detectOracleDrift` の閾値（reanchor≥2 / escalate≥4）に接続される。よって天井付近が
 * 2サイクル連続して初めて再アンカー指令が発火する（単発の高 net では発火しない）。
 */
export function deriveOracleDriftSignalFromHistory(
  entries: GoldHistoryEntry[],
  opts?: { netCeilingFloor?: number }
): OracleDriftSignal | undefined {
  const floor =
    typeof opts?.netCeilingFloor === 'number' && Number.isFinite(opts.netCeilingFloor)
      ? opts.netCeilingFloor
      : DEFAULT_SONNET_NET_CEILING_FLOOR;
  const withNet = entries.filter((e) => typeof e.net === 'number' && Number.isFinite(e.net));
  if (withNet.length < 2) return undefined;

  // 末尾から連続して床値以上のサイクル数（天井付近で頭打ちしている連続数）。
  let stagnantCycles = 0;
  for (let i = withNet.length - 1; i >= 0; i--) {
    if ((withNet[i].net as number) >= floor) stagnantCycles += 1;
    else break;
  }
  const last = withNet[withNet.length - 1].net as number;
  const proxySaturated = stagnantCycles >= 1 && last >= floor;
  if (!proxySaturated) return undefined;

  // 独立な真値KPI（記録されていれば）。window 内で上昇＝真feedbackが動いている＝drift ではない。
  const trueVals = withNet
    .map((e) =>
      typeof e.true_net === 'number'
        ? e.true_net
        : typeof e.true_accuracy === 'number'
          ? e.true_accuracy
          : undefined
    )
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const trueKpiMoving = trueVals.length >= 2 && trueVals[trueVals.length - 1] - trueVals[0] > 0;
  const trueKpiStagnant = !trueKpiMoving;
  if (!trueKpiStagnant) return undefined;

  const hasTrue = trueVals.length > 0;
  return {
    proxyKpiName: 'Sonnet gold100 net（自己参照 proxy: match−wrong）',
    proxySaturated,
    trueKpiName: hasTrue ? 'gold100 true-value accuracy' : 'true-value accuracy（未計測＝真feedback欠如）',
    trueKpiStagnant,
    stagnantCycles,
    detail: hasTrue
      ? `net≈${last} が天井(${floor}+)で${stagnantCycles}サイクル頭打ち・独立真値KPIも停滞。`
      : `net≈${last} が天井(${floor}+)で${stagnantCycles}サイクル頭打ち。独立な真値KPIが台帳に無く真feedbackが閉じていない（SIGNATE net99×真値88.5%の型）。`,
  };
}
