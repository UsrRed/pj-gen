/**
 * Enregistre des micro-sessions claude RÉELLES (sonnet, ~1k tokens chacune) en fixtures NDJSON.
 * Usage: npx tsx scripts/record-fixture.ts [outDir]
 * ⚠️ Consomme (très peu de) quota d'abonnement.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const outDir = process.argv[2] ?? path.resolve(import.meta.dirname, '../server/fixtures/ndjson');

function run(name: string, args: string[], promptText: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(d);
    });
    child.stdin.write(promptText);
    child.stdin.end();
    child.on('close', (code) => {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, `${name}.ndjson`), out);
      console.log(`\n→ fixture ${name}.ndjson écrite (exit ${code})`);
      resolve();
    });
    child.on('error', reject);
  });
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pjgen-fixture-'));
const base = ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet', '--strict-mcp-config', '--setting-sources', 'project,local'];

const sid = randomUUID();
await run('real-simple', [...base, '--session-id', sid, '--tools', ''], 'Réponds exactement: OK', cwd);
await run('real-resume', [...base, '--resume', sid, '--tools', ''], 'Réponds exactement: ENCORE OK', cwd);
await run(
  'real-schema',
  [...base, '--session-id', randomUUID(), '--tools', '', '--json-schema', JSON.stringify({ type: 'object', properties: { title: { type: 'string' }, spec_markdown: { type: 'string' } }, required: ['title', 'spec_markdown'] })],
  'Génère un mini spec (2 lignes) pour un outil CLI qui inverse une chaîne.',
  cwd
);
console.log('\nTerminé. Fixtures dans', outDir);
