// Local run: serves the app on http://localhost:4600 and hands the page the key from .env.
// Listens on 127.0.0.1 only. Never serves dotfiles, so .env itself is not reachable.
//   node dev/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.argv[2] ?? process.env.PORT ?? 4600);
const envFile = join(root, '.env');

// Read on every request, so a key pasted into .env works without a restart.
function readEnv() {
  if (!existsSync(envFile)) return {};
  const env = parseEnv(readFileSync(envFile, 'utf8'));
  return {
    apiKey: env.POSTHOG_PERSONAL_API_KEY?.trim() || '',
    host: env.POSTHOG_HOST?.trim() || 'https://eu.posthog.com',
  };
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/local-config.json') {
    const config = readEnv();
    // 200 with an empty object when .env has no key, so the page simply asks for one.
    res.writeHead(200, { 'Content-Type': types['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(config.apiKey ? config : {}));
    return;
  }
  const path = normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  const file = join(root, path);
  const hidden = path.split(/[\\/]/).some((part) => part.startsWith('.'));
  if (!file.startsWith(root + sep) || hidden) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  const hasKey = Boolean(readEnv().apiKey);
  console.log(`product_helper: http://localhost:${port}`);
  console.log(hasKey ? 'Key: taken from .env' : 'Key: not in .env — the app will ask for it');
});
