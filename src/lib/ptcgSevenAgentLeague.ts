import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SEVEN_AGENT_MANIFEST_SCHEMA = 'ptcg-seven-agent-league/v1' as const;
export const SEVEN_AGENT_IDS = ['sol', 'debate', 'fable', 'matsu', 'take', 'ume', 'zero'] as const;
export type SevenAgentId = (typeof SEVEN_AGENT_IDS)[number];

export type LeagueFaultKind = 'timeout' | 'illegal-action' | 'crash' | 'adapter';
export interface LeagueFault {
  kind: LeagueFaultKind;
  code: string;
  message: string;
}
export interface LeagueAction {
  type: string;
  payload?: unknown;
}
export interface LeagueStart {
  matchId: string;
  seed: number;
  seat: 'first' | 'second';
  deck: string;
}
export interface LeagueFinish {
  outcome: 'win' | 'loss' | 'draw' | 'fault';
  fault: LeagueFault | null;
}

export interface LeagueAgentRuntime {
  start(request: LeagueStart): Promise<void>;
  action(observation: unknown, timeoutMs: number): Promise<LeagueAction>;
  end(result: LeagueFinish): Promise<void>;
}

export interface AgentArtifact {
  id: SevenAgentId;
  repository: string;
  commit: string;
  entrypoint: string;
  deck: { path: string; commit: string; sha256: string };
  model: { path: string | null; commit: string };
  config: { path: string | null; commit: string };
}

export interface SevenAgentManifest {
  schemaVersion: typeof SEVEN_AGENT_MANIFEST_SCHEMA;
  engine: { id: string; commit: string };
  agents: AgentArtifact[];
}

const SHA_RE = /^[0-9a-f]{40}$/;
const DEFAULT_ENTRYPOINTS: Record<SevenAgentId, string> = {
  sol: 'main.py',
  debate: 'main.py',
  fable: 'main.py',
  matsu: 'main.py',
  take: 'main.py',
  ume: 'main.py',
  zero: 'main.py',
};

export function validateSevenAgentManifest(value: SevenAgentManifest): string[] {
  const errors: string[] = [];
  if (value.schemaVersion !== SEVEN_AGENT_MANIFEST_SCHEMA) errors.push('invalid schemaVersion');
  if (!SHA_RE.test(value.engine.commit)) errors.push('engine.commit must be a full commit SHA');
  if (value.agents.length !== SEVEN_AGENT_IDS.length)
    errors.push('manifest must contain seven agents');
  const ids = new Set(value.agents.map((a) => a.id));
  for (const id of SEVEN_AGENT_IDS) if (!ids.has(id)) errors.push(`missing agent: ${id}`);
  for (const agent of value.agents) {
    if (!SHA_RE.test(agent.commit)) errors.push(`${agent.id}.commit must be a full commit SHA`);
    for (const kind of ['deck', 'model', 'config'] as const)
      if (!SHA_RE.test(agent[kind].commit))
        errors.push(`${agent.id}.${kind}.commit must be a full commit SHA`);
    if (!/^[0-9a-f]{64}$/.test(agent.deck.sha256))
      errors.push(`${agent.id}.deck.sha256 must be sha256 hex`);
  }
  return errors;
}

function gitCommit(repo: string): string {
  const dotGit = path.join(repo, '.git');
  const git = fs.statSync(dotGit).isDirectory()
    ? dotGit
    : path.resolve(
        repo,
        fs
          .readFileSync(dotGit, 'utf8')
          .trim()
          .replace(/^gitdir:\s*/, '')
      );
  const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
  if (!head.startsWith('ref: ')) return head;
  const ref = head.slice(5);
  const loose = path.join(git, ref);
  if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim();
  const packed = fs.readFileSync(path.join(git, 'packed-refs'), 'utf8');
  return (
    packed
      .split('\n')
      .find((line) => line.endsWith(` ${ref}`))
      ?.split(' ')[0] ?? ''
  );
}

export function resolveSevenAgentManifest(
  siblingsRoot: string,
  engineCommit: string
): SevenAgentManifest {
  if (!SHA_RE.test(engineCommit)) throw new Error('engine.commit must be a full commit SHA');
  const agents = SEVEN_AGENT_IDS.map((id): AgentArtifact => {
    const repository = `ptcg-agent-${id}`;
    const repo = path.join(siblingsRoot, repository);
    if (!fs.existsSync(repo)) throw new Error(`agent repository not found: ${repository}`);
    const commit = gitCommit(repo);
    if (!SHA_RE.test(commit)) throw new Error(`cannot resolve full commit SHA: ${repository}`);
    const entrypoint = DEFAULT_ENTRYPOINTS[id];
    const deckPath = 'deck.csv';
    for (const relative of [entrypoint, deckPath])
      if (!fs.existsSync(path.join(repo, relative)))
        throw new Error(`${repository}: missing ${relative}`);
    const sha256 = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(repo, deckPath)))
      .digest('hex');
    return {
      id,
      repository,
      commit,
      entrypoint,
      deck: { path: deckPath, commit, sha256 },
      model: { path: null, commit },
      config: { path: null, commit },
    };
  });
  const manifest = {
    schemaVersion: SEVEN_AGENT_MANIFEST_SCHEMA,
    engine: { id: 'cabt', commit: engineCommit },
    agents,
  };
  const errors = validateSevenAgentManifest(manifest);
  if (errors.length) throw new Error(errors.join('; '));
  return manifest;
}

export function normalizeAgentFault(error: unknown): LeagueFault {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(message))
    return { kind: 'timeout', code: 'AGENT_TIMEOUT', message };
  if (/illegal|invalid action/i.test(message))
    return { kind: 'illegal-action', code: 'ILLEGAL_ACTION', message };
  if (error instanceof Error) return { kind: 'crash', code: 'AGENT_CRASH', message };
  return { kind: 'adapter', code: 'ADAPTER_ERROR', message };
}

export class CommonLeagueAdapter {
  constructor(
    readonly artifact: AgentArtifact,
    private readonly runtime: LeagueAgentRuntime
  ) {}
  async start(request: LeagueStart): Promise<{ ok: true } | { ok: false; fault: LeagueFault }> {
    try {
      await this.runtime.start(request);
      return { ok: true };
    } catch (error) {
      return { ok: false, fault: normalizeAgentFault(error) };
    }
  }
  async action(
    observation: unknown,
    timeoutMs: number
  ): Promise<{ action: LeagueAction; fault: null } | { action: null; fault: LeagueFault }> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`agent timeout after ${timeoutMs}ms`)),
          timeoutMs
        );
      });
      const action = await Promise.race([this.runtime.action(observation, timeoutMs), timeout]);
      if (!action || typeof action.type !== 'string' || !action.type)
        throw new Error('illegal action: missing type');
      return { action, fault: null };
    } catch (error) {
      return { action: null, fault: normalizeAgentFault(error) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async end(result: LeagueFinish): Promise<{ ok: true } | { ok: false; fault: LeagueFault }> {
    try {
      await this.runtime.end(result);
      return { ok: true };
    } catch (error) {
      return { ok: false, fault: normalizeAgentFault(error) };
    }
  }
}

export async function smokeSevenAgentAdapters(manifest: SevenAgentManifest): Promise<void> {
  for (const artifact of manifest.agents) {
    const adapter = new CommonLeagueAdapter(artifact, {
      async start() {},
      async action() {
        return { type: 'pass' };
      },
      async end() {},
    });
    const started = await adapter.start({
      matchId: `smoke.${artifact.id}`,
      seed: 1845,
      seat: 'first',
      deck: artifact.deck.path,
    });
    const action = await adapter.action({}, 100);
    const ended = await adapter.end({ outcome: 'draw', fault: null });
    if (!started.ok || action.fault || !ended.ok) throw new Error(`smoke failed: ${artifact.id}`);
  }
}
