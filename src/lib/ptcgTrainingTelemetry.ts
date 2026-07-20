import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertArtifactRedacted, redactArtifact } from './ptcgArtifactRedaction.js';

export const TELEMETRY_SCHEMA_VERSION = 'ptcg-training-telemetry/v1' as const;
export const TELEMETRY_GENERATOR_VERSION = 'ptcg-telemetry-generator/v1' as const;
export const SUPPORTED_TELEMETRY_SCHEMAS = [TELEMETRY_SCHEMA_VERSION] as const;

export type TelemetryMetric = 'policy' | 'value' | 'reward' | 'loss';

export interface TelemetryPoint {
  step: number;
  metric: TelemetryMetric;
  value: number;
  /** Optional series suffix, for example policy entropy or value MSE. */
  name?: string;
  wallTimeMs?: number;
}

export interface TelemetryRunMetadata {
  runId: string;
  createdAt: string;
  codeVersion: string;
  seed: number;
  command: string;
  conditions: Record<string, string | number | boolean>;
}

export interface TelemetryManifest {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  generatorVersion: typeof TELEMETRY_GENERATOR_VERSION;
  metadata: TelemetryRunMetadata;
  raw: { file: 'metrics.jsonl'; sha256: string; bytes: number; points: number };
}

export interface TelemetrySeries {
  tag: string;
  points: Array<{ step: number; value: number; wallTimeMs: number }>;
  min: number;
  max: number;
  mean: number;
  last: number;
}

export interface TelemetryAggregate {
  schemaVersion: 'ptcg-training-telemetry-aggregate/v1';
  sourceSchemaVersion: string;
  generatorVersion: string;
  metadata: TelemetryRunMetadata;
  series: TelemetrySeries[];
}

export interface ReplayResult {
  aggregate: TelemetryAggregate;
  aggregatePath: string;
  tensorBoardPath: string;
}

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function atomicWrite(file: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, file);
}

function assertSafeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error(`${label} must be a safe id`);
}

function validateMetadata(metadata: TelemetryRunMetadata): void {
  assertSafeId(metadata.runId, 'runId');
  if (!Number.isSafeInteger(metadata.seed) || metadata.seed < 0)
    throw new Error('seed must be a non-negative integer');
  if (!metadata.codeVersion.trim()) throw new Error('codeVersion is required');
  if (!metadata.command.trim()) throw new Error('command is required');
  if (!Number.isFinite(Date.parse(metadata.createdAt)))
    throw new Error('createdAt must be ISO-8601');
}

function validatePoint(point: TelemetryPoint): void {
  if (!Number.isSafeInteger(point.step) || point.step < 0)
    throw new Error('telemetry step must be a non-negative integer');
  if (!['policy', 'value', 'reward', 'loss'].includes(point.metric))
    throw new Error(`unknown telemetry metric: ${String(point.metric)}`);
  if (!Number.isFinite(point.value)) throw new Error('telemetry value must be finite');
  if (point.name !== undefined) assertSafeId(point.name, 'metric name');
  if (
    point.wallTimeMs !== undefined &&
    (!Number.isFinite(point.wallTimeMs) || point.wallTimeMs < 0)
  ) {
    throw new Error('wallTimeMs must be a non-negative number');
  }
}

/** Persist the immutable raw observations and the exact conditions needed to attribute the run. */
export function writeTelemetryArtifact(
  root: string,
  metadata: TelemetryRunMetadata,
  points: TelemetryPoint[]
): TelemetryManifest {
  const safeMetadata = redactArtifact(metadata);
  validateMetadata(safeMetadata);
  points.forEach(validatePoint);
  const runDir = path.join(root, safeMetadata.runId);
  const raw = `${points.map((point) => stableJson(point)).join('\n')}${points.length ? '\n' : ''}`;
  const rawBytes = Buffer.from(raw);
  const manifest: TelemetryManifest = {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    generatorVersion: TELEMETRY_GENERATOR_VERSION,
    metadata: safeMetadata,
    raw: {
      file: 'metrics.jsonl',
      sha256: sha256(rawBytes),
      bytes: rawBytes.length,
      points: points.length,
    },
  };
  assertArtifactRedacted(manifest);
  atomicWrite(path.join(runDir, manifest.raw.file), rawBytes);
  atomicWrite(path.join(runDir, 'manifest.json'), `${stableJson(manifest)}\n`);
  return manifest;
}

function loadRaw(
  root: string,
  runId: string
): { manifest: TelemetryManifest; points: TelemetryPoint[] } {
  assertSafeId(runId, 'runId');
  const runDir = path.join(root, runId);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8')
  ) as TelemetryManifest;
  if (!(SUPPORTED_TELEMETRY_SCHEMAS as readonly string[]).includes(manifest.schemaVersion)) {
    throw new Error(`unsupported telemetry schema: ${String(manifest.schemaVersion)}`);
  }
  validateMetadata(manifest.metadata);
  if (manifest.metadata.runId !== runId)
    throw new Error('manifest runId does not match requested run');
  const rawFile = path.join(runDir, manifest.raw.file);
  const raw = fs.readFileSync(rawFile);
  if (raw.length !== manifest.raw.bytes) throw new Error('raw telemetry size mismatch');
  if (sha256(raw) !== manifest.raw.sha256) throw new Error('raw telemetry checksum mismatch');
  const points = raw
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TelemetryPoint);
  if (points.length !== manifest.raw.points) throw new Error('raw telemetry point count mismatch');
  points.forEach(validatePoint);
  return { manifest, points };
}

function tagOf(point: TelemetryPoint): string {
  return point.name ? `${point.metric}/${point.name}` : point.metric;
}

export function aggregateTelemetry(
  manifest: TelemetryManifest,
  points: TelemetryPoint[]
): TelemetryAggregate {
  const grouped = new Map<string, Array<{ step: number; value: number; wallTimeMs: number }>>();
  for (const point of points) {
    const row = {
      step: point.step,
      value: point.value,
      wallTimeMs: point.wallTimeMs ?? Date.parse(manifest.metadata.createdAt),
    };
    const tag = tagOf(point);
    grouped.set(tag, [...(grouped.get(tag) ?? []), row]);
  }
  const series = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, rows]) => {
      rows.sort((a, b) => a.step - b.step || a.wallTimeMs - b.wallTimeMs);
      const values = rows.map((row) => row.value);
      return {
        tag,
        points: rows,
        min: Math.min(...values),
        max: Math.max(...values),
        mean: values.reduce((a, b) => a + b, 0) / values.length,
        last: values.at(-1)!,
      };
    });
  return {
    schemaVersion: 'ptcg-training-telemetry-aggregate/v1',
    sourceSchemaVersion: manifest.schemaVersion,
    generatorVersion: TELEMETRY_GENERATOR_VERSION,
    metadata: structuredClone(manifest.metadata),
    series,
  };
}

// Minimal protobuf + TFRecord encoder for TensorBoard Event.summary.value.simple_value scalars.
function varint(value: number): Buffer {
  const bytes: number[] = [];
  let current = BigInt(value);
  do {
    let byte = Number(current & 0x7fn);
    current >>= 7n;
    if (current) byte |= 0x80;
    bytes.push(byte);
  } while (current);
  return Buffer.from(bytes);
}
function fieldBytes(field: number, value: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(value.length), value]);
}
function fieldString(field: number, value: string): Buffer {
  return fieldBytes(field, Buffer.from(value));
}
function crc32c(data: Buffer): number {
  let crc = 0xffffffff;
  for (const octet of data) {
    crc ^= octet;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function maskedCrc(data: Buffer): Buffer {
  const crc = crc32c(data);
  const masked = (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
  const out = Buffer.alloc(4);
  out.writeUInt32LE(masked);
  return out;
}
function tfRecord(payload: Buffer): Buffer {
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(payload.length));
  return Buffer.concat([length, maskedCrc(length), payload, maskedCrc(payload)]);
}
function eventRecord(
  tag: string,
  point: { step: number; value: number; wallTimeMs: number }
): Buffer {
  const simpleValue = Buffer.alloc(4);
  simpleValue.writeFloatLE(point.value);
  const summaryValue = Buffer.concat([fieldString(1, tag), Buffer.from([0x15]), simpleValue]);
  const summary = fieldBytes(1, summaryValue);
  const wallTime = Buffer.alloc(9);
  wallTime[0] = 0x09;
  wallTime.writeDoubleLE(point.wallTimeMs / 1000, 1);
  return tfRecord(
    Buffer.concat([wallTime, Buffer.from([0x10]), varint(point.step), fieldBytes(5, summary)])
  );
}
function tensorBoardEvents(aggregate: TelemetryAggregate): Buffer {
  const version = tfRecord(fieldString(3, 'brain.Event:2'));
  const rows = aggregate.series
    .flatMap((series) => series.points.map((point) => ({ tag: series.tag, point })))
    .sort((a, b) => a.point.step - b.point.step || a.tag.localeCompare(b.tag));
  return Buffer.concat([version, ...rows.map(({ tag, point }) => eventRecord(tag, point))]);
}

/** Rebuild every derived artifact exclusively from checksum-verified raw observations. */
export function replayTelemetry(root: string, runId: string): ReplayResult {
  const { manifest, points } = loadRaw(root, runId);
  const aggregate = aggregateTelemetry(manifest, points);
  const runDir = path.join(root, runId);
  const aggregatePath = path.join(runDir, 'aggregate.json');
  const tensorBoardPath = path.join(runDir, 'tensorboard', `events.out.tfevents.${runId}`);
  atomicWrite(aggregatePath, `${stableJson(aggregate)}\n`);
  atomicWrite(tensorBoardPath, tensorBoardEvents(aggregate));
  return { aggregate, aggregatePath, tensorBoardPath };
}
