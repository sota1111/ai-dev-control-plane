import fs from 'node:fs';
import path from 'node:path';

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as T;
}

describe('SOT-2209 Biohub submission lineages', () => {
  const registry = readJson<{
    competitions: Array<{
      key: string;
      kaggle_competition: string;
      daily_submission_cap: number;
      daily_submissions_per_lineage: number;
      submission_mode: string;
      targets: Array<{
        lineage: string;
        repo: string;
        submit: { file: string; kernel: string; version: number; output: string };
      }>;
    }>;
  }>('scripts/ai/kaggle_targets_registry.json');
  const evidence = readJson<{
    competition: string;
    dailySubmissionCap: number;
    dailySubmissionsPerLineage: number;
    artifactContract: { file: string; output: string; submissionMode: string };
    previousResults: Record<string, { status: string; publicScore: number }>;
    lineages: Array<{
      lineage: string;
      repository: string;
      sourceRevision: string;
      kernel: string;
      kernelVersion: number;
      kernelStatus: string;
      acceptedSubmission: { submissionRef: number; statusAtRecordTime: string };
    }>;
  }>('docs/ai/kaggle/biohub-lineages.json');

  it('registers independent Claude/GPT repositories with the shared CSV contract', () => {
    const competition = registry.competitions.find((item) => item.key === 'biohub');
    expect(competition).toMatchObject({
      kaggle_competition: evidence.competition,
      daily_submission_cap: evidence.dailySubmissionCap,
      daily_submissions_per_lineage: evidence.dailySubmissionsPerLineage,
      submission_mode: 'both',
    });
    expect(competition?.targets).toMatchObject(
      evidence.lineages.map((lineage) => ({
        lineage: lineage.lineage,
        repo: `biohub-${lineage.lineage}`,
        submit: {
          file: evidence.artifactContract.file,
          kernel: lineage.kernel,
          version: lineage.kernelVersion,
          output: evidence.artifactContract.output,
        },
      }))
    );
    expect(new Set(evidence.lineages.map((item) => item.repository)).size).toBe(2);
    expect(evidence.lineages.every((item) => /^[0-9a-f]{40}$/.test(item.sourceRevision))).toBe(
      true
    );
  });

  it('records accepted submissions and the previous Claude/GPT scores', () => {
    expect(evidence.artifactContract).toEqual({
      file: 'submission.csv',
      output: 'submission.csv',
      submissionMode: 'notebook',
    });
    expect(evidence.lineages.map((item) => item.kernelStatus)).toEqual(['COMPLETE', 'COMPLETE']);
    expect(evidence.lineages.map((item) => item.acceptedSubmission.statusAtRecordTime)).toEqual([
      'PENDING',
      'PENDING',
    ]);
    expect(evidence.previousResults).toMatchObject({
      claude: { status: 'COMPLETE', publicScore: 0.509 },
      gpt: { status: 'COMPLETE', publicScore: 0 },
    });
  });
});
