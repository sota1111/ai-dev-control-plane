import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { renderBattleTimelinePage } from './lib/ptcgBattleTimelineViewer.js';

function usage(): never {
  console.error(
    'Usage: npx tsx src/ptcg-battle-viewer-cli.ts <battle-log.json> [--port <number>] [--host <address>]'
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const file = args[0];
if (!file || file.startsWith('--')) usage();
const portIndex = args.indexOf('--port');
const port = portIndex === -1 ? 4173 : Number(args[portIndex + 1]);
const hostIndex = args.indexOf('--host');
const host = hostIndex === -1 ? '127.0.0.1' : args[hostIndex + 1];
if (!Number.isInteger(port) || port < 1 || port > 65535) usage();
if (!host || host.startsWith('--')) usage();

try {
  const input: unknown = JSON.parse(await readFile(resolve(file), 'utf8'));
  const page = renderBattleTimelinePage(input);
  const server = createServer((request, response) => {
    if (request.url !== '/') {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(page),
    });
    response.end(page);
  });
  server.listen(port, host, () => {
    console.log(`Battle timeline viewer: http://${host}:${port}`);
    if (host === '0.0.0.0') {
      const addresses = Object.values(networkInterfaces())
        .flat()
        .filter((address) => address?.family === 'IPv4' && !address.internal)
        .map((address) => `http://${address!.address}:${port}`);
      for (const address of addresses) console.log(`Same-network device: ${address}`);
    }
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
