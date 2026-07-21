import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ARTIFACT_LINEAGE_SCHEMA = 'ptcg-artifact-lineage/v1' as const;

export interface ReplayInput {
  matchId: string;
  runId: string;
  payload: unknown;
}

export interface ContentRef {
  id: string;
  sha256: string;
  bytes: number;
}

export interface ReplayArtifact extends ContentRef {
  kind: 'replay';
  matchIds: string[];
  runIds: string[];
}

export interface ShardArtifact extends ContentRef {
  kind: 'shard';
  replayIds: string[];
}

export interface DatasetArtifact extends ContentRef {
  kind: 'dataset';
  shardIds: string[];
  replayCount: number;
}

export interface ModelArtifact extends ContentRef {
  kind: 'model';
  datasetId: string;
  training: Readonly<Record<string, unknown>>;
}

export interface ArtifactLineageManifest {
  schemaVersion: typeof ARTIFACT_LINEAGE_SCHEMA;
  replays: ReplayArtifact[];
  shards: ShardArtifact[];
  datasets: DatasetArtifact[];
  models: ModelArtifact[];
}

export interface ModelLineage {
  model: ModelArtifact;
  dataset: DatasetArtifact;
  shards: ShardArtifact[];
  replays: ReplayArtifact[];
  matches: string[];
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

function identity(kind: string, value: unknown): ContentRef {
  const bytes = Buffer.from(canonical(value));
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  return { id: `${kind}.sha256.${sha256}`, sha256, bytes: bytes.length };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export class ArtifactLineageBuilder {
  private readonly replayById = new Map<string, ReplayArtifact>();
  private readonly shardById = new Map<string, ShardArtifact>();
  private readonly datasetById = new Map<string, DatasetArtifact>();
  private readonly modelById = new Map<string, ModelArtifact>();

  addReplay(input: ReplayInput): ReplayArtifact {
    if (!input.matchId || !input.runId) throw new Error('replay matchId and runId are required');
    const ref = identity('replay', input.payload);
    const replay: ReplayArtifact = {
      ...ref,
      kind: 'replay',
      matchIds: [input.matchId],
      runIds: [input.runId],
    };
    const existing = this.replayById.get(replay.id);
    if (existing) {
      existing.matchIds = uniqueSorted([...existing.matchIds, input.matchId]);
      existing.runIds = uniqueSorted([...existing.runIds, input.runId]);
      return structuredClone(existing);
    }
    this.replayById.set(replay.id, replay);
    return structuredClone(replay);
  }

  addShard(replayIds: string[]): ShardArtifact {
    const ids = uniqueSorted(replayIds);
    if (!ids.length) throw new Error('shard requires at least one replay');
    ids.forEach((id) => {
      if (!this.replayById.has(id)) throw new Error(`unknown replay ${id}`);
    });
    const ref = identity('shard', ids);
    const shard: ShardArtifact = { ...ref, kind: 'shard', replayIds: ids };
    this.shardById.set(shard.id, shard);
    return structuredClone(shard);
  }

  addDataset(shardIds: string[]): DatasetArtifact {
    const ids = uniqueSorted(shardIds);
    if (!ids.length) throw new Error('dataset requires at least one shard');
    const replayIds = uniqueSorted(
      ids.flatMap((id) => {
        const shard = this.shardById.get(id);
        if (!shard) throw new Error(`unknown shard ${id}`);
        return shard.replayIds;
      })
    );
    const ref = identity('dataset', ids);
    const dataset: DatasetArtifact = {
      ...ref,
      kind: 'dataset',
      shardIds: ids,
      replayCount: replayIds.length,
    };
    this.datasetById.set(dataset.id, dataset);
    return structuredClone(dataset);
  }

  addModel(datasetId: string, training: Readonly<Record<string, unknown>>): ModelArtifact {
    if (!this.datasetById.has(datasetId)) throw new Error(`unknown dataset ${datasetId}`);
    const normalized = JSON.parse(canonical(training)) as Record<string, unknown>;
    const ref = identity('model', { datasetId, training: normalized });
    const model: ModelArtifact = { ...ref, kind: 'model', datasetId, training: normalized };
    this.modelById.set(model.id, model);
    return structuredClone(model);
  }

  manifest(): ArtifactLineageManifest {
    const sorted = <T extends ContentRef>(values: Iterable<T>): T[] =>
      [...values].sort((left, right) => left.id.localeCompare(right.id));
    return {
      schemaVersion: ARTIFACT_LINEAGE_SCHEMA,
      replays: sorted(this.replayById.values()),
      shards: sorted(this.shardById.values()),
      datasets: sorted(this.datasetById.values()),
      models: sorted(this.modelById.values()),
    };
  }
}

export function validateLineage(manifest: ArtifactLineageManifest): string[] {
  const errors: string[] = [];
  if (manifest.schemaVersion !== ARTIFACT_LINEAGE_SCHEMA) errors.push('unsupported lineage schema');
  const unique = <T extends ContentRef>(kind: string, items: T[]): Map<string, T> => {
    const map = new Map<string, T>();
    items.forEach((item) => {
      if (map.has(item.id)) errors.push(`duplicate ${kind} ${item.id}`);
      if (item.id !== `${kind}.sha256.${item.sha256}`)
        errors.push(`${kind} ${item.id} identity mismatch`);
      map.set(item.id, item);
    });
    return map;
  };
  const replays = unique('replay', manifest.replays);
  const shards = unique('shard', manifest.shards);
  const datasets = unique('dataset', manifest.datasets);
  unique('model', manifest.models);
  manifest.replays.forEach((item) => {
    if (!item.matchIds.length || !item.runIds.length)
      errors.push(`replay ${item.id} lineage is empty`);
  });
  manifest.shards.forEach((item) => {
    const expected = identity('shard', uniqueSorted(item.replayIds));
    if (item.sha256 !== expected.sha256 || item.bytes !== expected.bytes)
      errors.push(`shard ${item.id} content identity mismatch`);
    item.replayIds.forEach(
      (id) => !replays.has(id) && errors.push(`shard ${item.id} references ${id}`)
    );
  });
  manifest.datasets.forEach((item) => {
    const expected = identity('dataset', uniqueSorted(item.shardIds));
    if (item.sha256 !== expected.sha256 || item.bytes !== expected.bytes)
      errors.push(`dataset ${item.id} content identity mismatch`);
    item.shardIds.forEach(
      (id) => !shards.has(id) && errors.push(`dataset ${item.id} references ${id}`)
    );
  });
  manifest.models.forEach((item) => {
    const expected = identity('model', { datasetId: item.datasetId, training: item.training });
    if (item.sha256 !== expected.sha256 || item.bytes !== expected.bytes)
      errors.push(`model ${item.id} content identity mismatch`);
    if (!datasets.has(item.datasetId)) errors.push(`model ${item.id} references ${item.datasetId}`);
  });
  return errors;
}

export function traceModel(manifest: ArtifactLineageManifest, modelId: string): ModelLineage {
  const errors = validateLineage(manifest);
  if (errors.length) throw new Error(errors.join('; '));
  const model = manifest.models.find((item) => item.id === modelId);
  if (!model) throw new Error(`unknown model ${modelId}`);
  const dataset = manifest.datasets.find((item) => item.id === model.datasetId)!;
  const shards = dataset.shardIds.map((id) => manifest.shards.find((item) => item.id === id)!);
  const replayIds = uniqueSorted(shards.flatMap((item) => item.replayIds));
  const replays = replayIds.map((id) => manifest.replays.find((item) => item.id === id)!);
  return {
    model,
    dataset,
    shards,
    replays,
    matches: uniqueSorted(replays.flatMap((item) => item.matchIds)),
  };
}

export function saveLineage(file: string, manifest: ArtifactLineageManifest): void {
  const errors = validateLineage(manifest);
  if (errors.length) throw new Error(errors.join('; '));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.partial`;
  fs.writeFileSync(temporary, `${canonical(manifest)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function loadLineage(file: string): ArtifactLineageManifest {
  if (fs.existsSync(`${file}.partial`))
    throw new Error(`partial artifact detected: ${file}.partial`);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as ArtifactLineageManifest;
  const errors = validateLineage(manifest);
  if (errors.length) throw new Error(errors.join('; '));
  return manifest;
}

/** Remove only an incomplete staging file, then deterministically rebuild the final manifest. */
export function recoverLineage(
  file: string,
  rebuild: () => ArtifactLineageManifest
): ArtifactLineageManifest {
  const partial = `${file}.partial`;
  if (fs.existsSync(partial)) fs.unlinkSync(partial);
  const manifest = rebuild();
  saveLineage(file, manifest);
  return loadLineage(file);
}
