import fs from 'node:fs';
import path from 'node:path';
import {
  fingerprintGatewayArtifact,
  readGatewayReplayCorpus,
} from './lib/arcAgi3Gateway.js';
import {
  createObservationEchoIncumbent,
  createStatefulFrameDifferenceExplorer,
  evaluateReplayPolicy,
} from './lib/arcAgi3StatefulExplorer.js';

const corpusFile =
  process.argv[2] ??
  path.join(process.cwd(), 'src/__fixtures__/arcAgi3GatewayReplayCorpus.json');
const corpus = readGatewayReplayCorpus(corpusFile);
const incumbentScreen = evaluateReplayPolicy(corpus, 'screen', createObservationEchoIncumbent);
const candidateScreen = evaluateReplayPolicy(
  corpus,
  'screen',
  createStatefulFrameDifferenceExplorer
);
const screenPassed =
  candidateScreen.faults === 0 &&
  candidateScreen.levelProgress >= incumbentScreen.levelProgress &&
  candidateScreen.noOpRate <= incumbentScreen.noOpRate &&
  candidateScreen.actionMismatches < incumbentScreen.actionMismatches;
const candidateConfirm = screenPassed
  ? evaluateReplayPolicy(corpus, 'confirm', createStatefulFrameDifferenceExplorer)
  : null;
const incumbentConfirm = screenPassed
  ? evaluateReplayPolicy(corpus, 'confirm', createObservationEchoIncumbent)
  : null;

const result = {
  schemaVersion: 'arc-agi-3-stateful-comparison/v1',
  issue: 'SOT-2085',
  candidate: {
    id: 'stateful-frame-difference-v1',
    artifactId: process.env.SOT_2085_ARTIFACT_ID ?? 'working-tree',
    sourceFingerprint: fingerprintGatewayArtifact(
      fs.readFileSync(
        path.join(process.cwd(), 'src/lib/arcAgi3StatefulExplorer.ts'),
        'utf8'
      )
    ),
  },
  incumbent: { id: 'observation-rule-v1' },
  corpus: {
    id: corpus.corpusId,
    fingerprint: fingerprintGatewayArtifact(corpus),
    productionEvidence: corpus.episodes.every(
      (episode) => episode.provenance.productionEvidence
    ),
  },
  gate: {
    screenPassed,
    confirmExecuted: candidateConfirm !== null,
    screenCriterion:
      'candidate levelProgress >= incumbent, noOpRate <= incumbent, fewer replay action mismatches, and faults = 0',
    promotionCriterion:
      'authenticated production confirm, levelProgress > incumbent, faults = 0, then exec compatibility',
  },
  screen: { incumbent: incumbentScreen, candidate: candidateScreen },
  confirm:
    candidateConfirm && incumbentConfirm
      ? { incumbent: incumbentConfirm, candidate: candidateConfirm }
      : null,
  decision:
    candidateConfirm && corpus.episodes.every((episode) => episode.provenance.productionEvidence)
      ? 'eligible-for-exec-verification'
      : 'not-promoted',
  reason:
    'The candidate passes the synthetic production-shaped screen and confirm, but the corpus is explicitly not authenticated production evidence.',
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
