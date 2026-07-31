import fs from 'node:fs';
import path from 'node:path';

interface ChampionRecord {
  champion: {
    detectorId: string;
    artifactId: string;
    evaluationFingerprint: string;
  };
}

interface SubmissionAudit {
  champion: ChampionRecord['champion'];
  screen: { passed: boolean };
  confirm: {
    passed: boolean;
    kaggleContract: { track: string; requiredFile: string; requiredClass: string };
    championContract: { track: string };
  };
  kaggleProof: {
    status: string;
    reasonCode: string;
    submissionCreated: boolean;
    observedExistingSubmission: { countsAsChampionProof: boolean };
  };
  decision: {
    action: string;
    nonPromotedChangesIncluded: boolean;
    registryMutationRequired: boolean;
  };
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as T;
}

describe('SOT-1966 champion submission audit', () => {
  const champion = readJson<ChampionRecord>(
    'artifacts/agent-security/sot-1963/champion.json'
  ).champion;
  const audit = readJson<SubmissionAudit>(
    'artifacts/agent-security/sot-1966/submission-audit.json'
  );
  const registry = readJson<{
    competitions: Array<{
      key: string;
      daily_submissions_per_lineage?: number;
      targets: Array<{
        lineage: string;
        repo: string;
        submit: {
          file: string;
          kernel?: string;
          version?: number;
          output?: string;
        };
      }>;
    }>;
  }>('scripts/ai/kaggle_targets_registry.json');

  it('binds the audited artifact to the unchanged production champion', () => {
    expect(audit.champion).toEqual({
      detectorId: champion.detectorId,
      artifactId: champion.artifactId,
      evaluationFingerprint: champion.evaluationFingerprint,
    });
    expect(audit.screen.passed).toBe(true);
    expect(audit.decision.nonPromotedChangesIncluded).toBe(false);
  });

  it('records the confirmed track mismatch and refuses a misleading submission', () => {
    expect(audit.confirm).toMatchObject({
      passed: false,
      kaggleContract: {
        track: 'redteam',
        requiredFile: 'attack.py',
        requiredClass: 'AttackAlgorithm',
      },
      championContract: { track: 'defense' },
    });
    expect(audit.kaggleProof).toMatchObject({
      status: 'skipped',
      reasonCode: 'champion_contract_incompatible_with_competition_track',
      submissionCreated: false,
      observedExistingSubmission: { countsAsChampionProof: false },
    });
    expect(audit.decision).toMatchObject({
      action: 'skip',
      registryMutationRequired: false,
    });
  });

  it('registers independent Claude/GPT lineages with one shared artifact contract', () => {
    const competition = registry.competitions.find((item) => item.key === 'agent-security');
    expect(competition?.daily_submissions_per_lineage).toBe(2);
    expect(competition?.targets).toMatchObject([
      {
        lineage: 'claude',
        repo: 'agent-security-claude',
        submit: {
          file: 'submission.csv',
          kernel: 'sota1111/agent-security-claude-cli-baseline',
          version: 2,
          output: 'submission.csv',
        },
      },
      {
        lineage: 'gpt',
        repo: 'agent-security-gpt',
        submit: {
          file: 'submission.csv',
          kernel: 'sota1111/agent-security-gpt-champion',
          version: 2,
          output: 'submission.csv',
        },
      },
    ]);
  });
});
