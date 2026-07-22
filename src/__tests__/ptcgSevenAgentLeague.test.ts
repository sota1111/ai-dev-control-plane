import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CommonLeagueAdapter,
  resolveSevenAgentManifest,
  SEVEN_AGENT_IDS,
  smokeSevenAgentAdapters,
  validateSevenAgentManifest,
  type AgentArtifact,
} from '../lib/ptcgSevenAgentLeague.js';

const SHA = 'a'.repeat(40);
const artifact: AgentArtifact = {
  id: 'sol',
  repository: 'ptcg-agent-sol',
  commit: SHA,
  entrypoint: 'main.py',
  deck: { path: 'deck.csv', commit: SHA, sha256: 'b'.repeat(64) },
  model: { path: null, commit: SHA },
  config: { path: null, commit: SHA },
};

function fixtureRepos(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seven-agent-'));
  for (const id of SEVEN_AGENT_IDS) {
    const repo = path.join(root, `ptcg-agent-${id}`);
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), SHA + '\n');
    fs.writeFileSync(path.join(repo, 'main.py'), '# fixture\n');
    fs.writeFileSync(path.join(repo, 'deck.csv'), `deck-${id}\n`);
  }
  return root;
}

describe('seven-agent common league', () => {
  it('pins all seven agents and deck/model/config artifacts to full commits and smoke starts them', async () => {
    const manifest = resolveSevenAgentManifest(fixtureRepos(), SHA);
    expect(manifest.agents.map((a) => a.id)).toEqual(SEVEN_AGENT_IDS);
    expect(validateSevenAgentManifest(manifest)).toEqual([]);
    expect(
      manifest.agents.every(
        (a) =>
          a.commit === SHA &&
          a.deck.commit === SHA &&
          a.model.commit === SHA &&
          a.config.commit === SHA
      )
    ).toBe(true);
    await expect(smokeSevenAgentAdapters(manifest)).resolves.toBeUndefined();
  });

  it('fails explicitly when a pinned repository or artifact cannot be resolved', () => {
    const root = fixtureRepos();
    fs.unlinkSync(path.join(root, 'ptcg-agent-debate', 'deck.csv'));
    expect(() => resolveSevenAgentManifest(root, SHA)).toThrow(
      'ptcg-agent-debate: missing deck.csv'
    );
    expect(() => resolveSevenAgentManifest(fixtureRepos(), 'main')).toThrow(
      'engine.commit must be a full commit SHA'
    );
  });

  it('normalizes timeout and illegal action faults across adapters', async () => {
    const timeout = new CommonLeagueAdapter(artifact, {
      async start() {},
      async action() {
        return new Promise(() => undefined);
      },
      async end() {},
    });
    expect((await timeout.action({}, 1)).fault).toMatchObject({
      kind: 'timeout',
      code: 'AGENT_TIMEOUT',
    });
    const illegal = new CommonLeagueAdapter(artifact, {
      async start() {},
      async action() {
        return { type: '' };
      },
      async end() {},
    });
    expect((await illegal.action({}, 10)).fault).toMatchObject({
      kind: 'illegal-action',
      code: 'ILLEGAL_ACTION',
    });
  });
});
