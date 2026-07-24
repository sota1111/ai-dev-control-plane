import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderBattleTimelinePage } from './lib/ptcgBattleTimelineViewer.js';

function usage(): never {
  console.error('Usage: npx tsx src/ptcg-battle-viewer-cli.ts <battle-log.json> [--port <number>]');
  process.exit(2);
}

const args = process.argv.slice(2);
const file = args[0];
if (!file || file.startsWith('--')) usage();
const portIndex = args.indexOf('--port');
const port = portIndex === -1 ? 4173 : Number(args[portIndex + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) usage();

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
  server.listen(port, '127.0.0.1', () => {
    console.log(`Battle timeline viewer: http://127.0.0.1:${port}`);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
