import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ArtifactLineageBuilder,
  loadLineage,
  recoverLineage,
  saveLineage,
  traceModel,
} from '../lib/ptcgArtifactLineage.js';

function build() {
  const builder = new ArtifactLineageBuilder();
  const first = builder.addReplay({
    runId: 'run.1',
    matchId: 'match.1',
    payload: { winner: 'matsu' },
  });
  const duplicate = builder.addReplay({
    runId: 'run.2',
    matchId: 'match.3',
    payload: { winner: 'matsu' },
  });
  const second = builder.addReplay({
    runId: 'run.1',
    matchId: 'match.2',
    payload: { winner: 'take' },
  });
  const shard = builder.addShard([second.id, first.id, duplicate.id]);
  const dataset = builder.addDataset([shard.id, shard.id]);
  const model = builder.addModel(dataset.id, { epochs: 4, optimizer: 'adam' });
  return { builder, first, duplicate, dataset, model };
}

describe('PTCG artifact lineage', () => {
  it('builds a reproducible manifest and deduplicates replay and shard inputs', () => {
    const one = build();
    const two = build();
    expect(one.builder.manifest()).toEqual(two.builder.manifest());
    expect(one.first.id).toBe(one.duplicate.id);
    expect(one.builder.manifest().replays).toHaveLength(2);
    expect(one.dataset.replayCount).toBe(2);
    expect(one.builder.manifest().datasets).toHaveLength(1);
  });

  it('traces a model back to its dataset, replays, and matches', () => {
    const built = build();
    const lineage = traceModel(built.builder.manifest(), built.model.id);
    expect(lineage.dataset.id).toBe(built.dataset.id);
    expect(lineage.replays.map((item) => item.id)).toHaveLength(2);
    expect(lineage.matches).toEqual(['match.1', 'match.2', 'match.3']);
  });

  it('detects a partial artifact and safely regenerates it', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptcg-lineage-'));
    const file = path.join(directory, 'manifest.json');
    const manifest = build().builder.manifest();
    fs.writeFileSync(`${file}.partial`, '{truncated');
    expect(() => loadLineage(file)).toThrow('partial artifact detected');
    expect(recoverLineage(file, () => manifest)).toEqual(manifest);
    expect(fs.existsSync(`${file}.partial`)).toBe(false);
  });

  it('rejects corrupt references rather than silently resuming', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ptcg-lineage-'));
    const file = path.join(directory, 'manifest.json');
    const manifest = build().builder.manifest();
    saveLineage(file, manifest);
    const corrupt = JSON.parse(fs.readFileSync(file, 'utf8'));
    corrupt.datasets[0].shardIds = ['shard.sha256.missing'];
    fs.writeFileSync(file, JSON.stringify(corrupt));
    expect(() => loadLineage(file)).toThrow('references shard.sha256.missing');
  });
});
