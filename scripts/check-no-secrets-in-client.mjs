/**
 * CI guard: fail if known secret env var names appear in the Next.js
 * client bundle (static/chunks). Server chunks are excluded.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const CLIENT_DIR = join(ROOT, '.next', 'static');

const FORBIDDEN = [
  'ANTHROPIC_API_KEY',
  'RAINFOREST_API_KEY',
  'FIRECRAWL_API_KEY',
  'sk-ant-',
  'process.env.ANTHROPIC',
];

function walk(dir, files = []) {
  if (!statSync(dir, { throwIfNoEntry: false })) return files;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, files);
    else if (/\.(js|mjs|cjs)$/.test(name)) files.push(p);
  }
  return files;
}

const clientFiles = walk(CLIENT_DIR);
if (clientFiles.length === 0) {
  console.error('No client bundle found — run `npm run build` first.');
  process.exit(1);
}

const hits = [];
for (const file of clientFiles) {
  const text = readFileSync(file, 'utf8');
  for (const needle of FORBIDDEN) {
    if (text.includes(needle)) hits.push({ file, needle });
  }
}

if (hits.length) {
  console.error('Secret leakage detected in client bundle:');
  for (const h of hits) console.error(`  ${h.needle} in ${h.file}`);
  process.exit(1);
}

console.log(`check:secrets OK — scanned ${clientFiles.length} client chunk(s).`);
