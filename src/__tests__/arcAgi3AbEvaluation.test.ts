import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARC_AB_CONDITIONS,
  buildArcAbEvaluationPlan,
  decideArcAbChampionPromotion,
  planNextImprovementIssue,
  promoteArcAbChampion,
  writeArcAbArtifact,
  writeArcAbChampionSettings,
  type ArcAbArtifact,
  type ArcAbEvaluationConfig,
  type ArcAbTelemetry,
} from '../lib/arcAgi3AbEvaluation.js';

describe('arcAgi3AbEvaluation', () => {
  const config: ArcAbEvaluationConfig = {
    gameIds: ['game-a', 'game-b'],
    actionBudget: 100,
    trialsPerGame: 2,
    seed: 42,
    guardrails: {
      maxTotalTokensRatio: 1.1,
      maxApiCostRatio: 1.1,
      maxLatencyRatio: 1.2,
    },
  };

  const artifact = (mutate?: (rows: ArcAbTelemetry[]) => void): ArcAbArtifact => {
    const runs = buildArcAbEvaluationPlan('SOT-2191', config);
    const telemetry = runs.map(
      (run): ArcAbTelemetry => ({
        condition: run.condition,
        gameId: run.gameId,
        trial: run.trial,
        score: run.condition === 'retained_reasoning' ? 11 : 10,
        levelCompletion: 1,
        actions: 50,
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 25,
        durationMs: 1_000,
        apiCostUsd: 0.01,
      })
    );
    mutate?.(telemetry);
    return {
      schemaVersion: 1,
      issueId: 'SOT-2191',
      createdAt: '2026-07-30T00:00:00.000Z',
      config,
      runs,
      telemetry,
    };
  };

  test('fixes all comparison inputs and isolates every response chain', () => {
    const runs = buildArcAbEvaluationPlan('SOT-2191', config);
    expect(runs).toHaveLength(16);
    expect(new Set(runs.map((run) => run.condition))).toEqual(new Set(ARC_AB_CONDITIONS));
    expect(new Set(runs.map((run) => run.actionBudget))).toEqual(new Set([100]));
    expect(new Set(runs.map((run) => run.responseChainKey)).size).toBe(runs.length);
    for (const condition of ARC_AB_CONDITIONS) {
      expect(
        runs
          .filter((run) => run.condition === condition)
          .map(({ gameId, trial, seed }) => ({ gameId, trial, seed }))
      ).toEqual([
        { gameId: 'game-a', trial: 1, seed: 42 },
        { gameId: 'game-a', trial: 2, seed: 43 },
        { gameId: 'game-b', trial: 1, seed: 42 },
        { gameId: 'game-b', trial: 2, seed: 43 },
      ]);
    }
  });

  test('missing telemetry never promotes', () => {
    const result = decideArcAbChampionPromotion(
      artifact((rows) => {
        rows.pop();
      })
    );
    expect(result).toMatchObject({ promote: false, championCondition: 'baseline' });
    expect(result.reason).toMatch(/missing telemetry/);
  });

  test('a guardrail regression never promotes', () => {
    const result = decideArcAbChampionPromotion(
      artifact((rows) => {
        rows
          .filter((row) => row.condition === 'retained_reasoning')
          .forEach((row) => {
            row.reasoningTokens = 1_000;
          });
      })
    );
    expect(result).toMatchObject({ promote: false, championCondition: 'baseline' });
  });

  test('only the highest-scoring eligible condition is promoted', () => {
    expect(decideArcAbChampionPromotion(artifact())).toMatchObject({
      promote: true,
      championCondition: 'retained_reasoning',
    });
  });

  test('persists KPIs and updates champion settings only for a valid improvement', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-ab-'));
    const evidence = artifact();
    const evidenceFile = path.join(directory, 'evaluation.json');
    const championFile = path.join(directory, 'champion.json');
    const incumbent = {
      schemaVersion: 1 as const,
      condition: 'baseline' as const,
      sourceIssueId: 'SOT-previous',
      artifactPath: 'artifacts/previous.json',
      promotedAt: '2026-07-29T00:00:00.000Z',
    };
    writeArcAbArtifact(evidenceFile, evidence);
    const promoted = promoteArcAbChampion(
      incumbent,
      evidence,
      'artifacts/SOT-2191.json',
      '2026-07-30T00:00:00.000Z'
    );
    writeArcAbChampionSettings(championFile, promoted);
    expect(JSON.parse(fs.readFileSync(evidenceFile, 'utf8')).telemetry[0]).toMatchObject({
      score: 10,
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 25,
      durationMs: 1_000,
      apiCostUsd: 0.01,
    });
    expect(JSON.parse(fs.readFileSync(championFile, 'utf8'))).toMatchObject({
      condition: 'retained_reasoning',
      sourceIssueId: 'SOT-2191',
    });
    expect(
      promoteArcAbChampion(
        incumbent,
        artifact((rows) => {
          rows
            .filter((row) => row.condition === 'retained_reasoning')
            .forEach((row) => {
              row.apiCostUsd = 1;
            });
        }),
        'artifacts/rejected.json',
        '2026-07-30T00:00:00.000Z'
      )
    ).toBe(incumbent);
  });

  test('next issue registration is idempotent and automatic', () => {
    const first = planNextImprovementIssue('arc-agi-3-gpt', 'SOT-2191', 7, []);
    expect(first).toMatchObject({ action: 'create' });
    expect(first.reason).toContain('automatically');
    expect(
      planNextImprovementIssue('arc-agi-3-gpt', 'SOT-2191', 7, [first.idempotencyKey])
    ).toMatchObject({ action: 'skip', idempotencyKey: first.idempotencyKey });
  });
});
