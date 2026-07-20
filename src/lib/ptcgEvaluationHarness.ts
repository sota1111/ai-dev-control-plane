import crypto from 'node:crypto';

export const EVALUATION_PROTOCOL_VERSION = 'ptcg-evaluation-protocol/v1' as const;

export interface EvaluationDeck {
  id: string;
  contentHash: string;
}

export interface EvaluationOpponent {
  snapshotId: string;
  artifactId: string;
}

export interface EvaluationMethod {
  id: string;
  artifactId: string;
}

/** Complete, serializable conditions required to reproduce and audit a comparison. */
export interface EvaluationProtocol {
  protocolVersion: typeof EVALUATION_PROTOCOL_VERSION;
  environmentVersion: string;
  baseSeed: number;
  repetitions: number;
  decks: EvaluationDeck[];
  opponentPool: EvaluationOpponent[];
  methods: EvaluationMethod[];
}

export interface EvaluationMatch {
  matchId: string;
  methodId: string;
  methodArtifactId: string;
  opponentSnapshotId: string;
  opponentArtifactId: string;
  deckId: string;
  deckHash: string;
  repetition: number;
  seed: number;
  /** 0: evaluated method is first; 1: opponent is first. */
  orientation: 0 | 1;
  seat0: 'method' | 'opponent';
  seat1: 'method' | 'opponent';
}

export interface EvaluationOutcome {
  winner: 'method' | 'opponent' | 'draw';
  turns?: number;
  metadata?: Record<string, string | number | boolean>;
}

export interface EvaluationResult extends EvaluationMatch {
  outcome: EvaluationOutcome;
}

export interface EvaluationRun {
  protocol: EvaluationProtocol;
  /** Hash of canonical protocol JSON, binding every result to its exact conditions. */
  protocolFingerprint: string;
  results: EvaluationResult[];
}

export type EvaluationRunner = (match: Readonly<EvaluationMatch>) => Promise<EvaluationOutcome>;

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function canonicalProtocol(protocol: EvaluationProtocol): EvaluationProtocol {
  return {
    ...structuredClone(protocol),
    decks: [...protocol.decks].sort((a, b) => a.id.localeCompare(b.id)),
    opponentPool: [...protocol.opponentPool].sort((a, b) =>
      a.snapshotId.localeCompare(b.snapshotId)
    ),
    methods: [...protocol.methods].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function stableUint32(value: string): number {
  return Number.parseInt(crypto.createHash('sha256').update(value).digest('hex').slice(0, 8), 16);
}

function assertUnique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${name} must be unique`);
}

export function validateEvaluationProtocol(protocol: EvaluationProtocol): void {
  if (protocol.protocolVersion !== EVALUATION_PROTOCOL_VERSION)
    throw new Error(`protocolVersion must be ${EVALUATION_PROTOCOL_VERSION}`);
  if (!protocol.environmentVersion.trim()) throw new Error('environmentVersion is required');
  if (!Number.isSafeInteger(protocol.baseSeed) || protocol.baseSeed < 0)
    throw new Error('baseSeed must be a non-negative safe integer');
  if (!Number.isSafeInteger(protocol.repetitions) || protocol.repetitions < 1)
    throw new Error('repetitions must be a positive safe integer');
  if (!protocol.decks.length) throw new Error('at least one deck is required');
  if (!protocol.opponentPool.length) throw new Error('opponentPool must not be empty');
  if (!protocol.methods.length) throw new Error('at least one method is required');
  assertUnique(
    protocol.decks.map((deck) => deck.id),
    'deck ids'
  );
  assertUnique(
    protocol.opponentPool.map((opponent) => opponent.snapshotId),
    'opponent snapshot ids'
  );
  assertUnique(
    protocol.methods.map((method) => method.id),
    'method ids'
  );
  for (const id of [
    ...protocol.decks.map((deck) => deck.id),
    ...protocol.opponentPool.map((opponent) => opponent.snapshotId),
    ...protocol.methods.map((method) => method.id),
  ]) {
    if (!ID_RE.test(id)) throw new Error(`invalid stable id: ${id}`);
  }
  for (const deck of protocol.decks)
    if (!deck.contentHash) throw new Error(`deck ${deck.id} needs contentHash`);
  for (const opponent of protocol.opponentPool)
    if (!opponent.artifactId) throw new Error(`opponent ${opponent.snapshotId} needs artifactId`);
  for (const method of protocol.methods)
    if (!method.artifactId) throw new Error(`method ${method.id} needs artifactId`);
}

export function evaluationProtocolFingerprint(protocol: EvaluationProtocol): string {
  validateEvaluationProtocol(protocol);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalProtocol(protocol)))
    .digest('hex');
}

/**
 * Builds the exact same matrix for every method: every deck × opponent × repetition uses both seat
 * orientations and shares its seed across methods and orientations. This controls input, opponent,
 * RNG and first-player bias instead of relying on aggregate balancing after the fact.
 */
export function buildEvaluationPlan(protocol: EvaluationProtocol): EvaluationMatch[] {
  validateEvaluationProtocol(protocol);
  const fixed = canonicalProtocol(protocol);
  const plan: EvaluationMatch[] = [];
  for (const method of fixed.methods) {
    for (const deck of fixed.decks) {
      for (const opponent of fixed.opponentPool) {
        for (let repetition = 0; repetition < fixed.repetitions; repetition++) {
          const condition = `${deck.id}:${opponent.snapshotId}:${repetition}`;
          const seed = (fixed.baseSeed + stableUint32(condition)) >>> 0;
          for (const orientation of [0, 1] as const) {
            plan.push({
              matchId: `${method.id}:${condition}:seat${orientation}`,
              methodId: method.id,
              methodArtifactId: method.artifactId,
              opponentSnapshotId: opponent.snapshotId,
              opponentArtifactId: opponent.artifactId,
              deckId: deck.id,
              deckHash: deck.contentHash,
              repetition,
              seed,
              orientation,
              seat0: orientation === 0 ? 'method' : 'opponent',
              seat1: orientation === 0 ? 'opponent' : 'method',
            });
          }
        }
      }
    }
  }
  return plan;
}

/** Execute any number of methods through one common match interface and return an auditable artifact. */
export async function runEvaluation(
  protocol: EvaluationProtocol,
  runners: Readonly<Record<string, EvaluationRunner>>
): Promise<EvaluationRun> {
  const fixed = canonicalProtocol(protocol);
  const results: EvaluationResult[] = [];
  for (const match of buildEvaluationPlan(fixed)) {
    const runner = runners[match.methodId];
    if (!runner) throw new Error(`missing runner for method ${match.methodId}`);
    const outcome = await runner(structuredClone(match));
    if (!['method', 'opponent', 'draw'].includes(outcome.winner))
      throw new Error(`runner ${match.methodId} returned an invalid winner`);
    results.push({ ...match, outcome: structuredClone(outcome) });
  }
  return { protocol: fixed, protocolFingerprint: evaluationProtocolFingerprint(fixed), results };
}
