#!/usr/bin/env node
/**
 * Securely capture local development credentials.
 *
 *   node scripts/set-local-secrets.mjs
 *
 * Why this exists: local development needs GEMINI_KEY and SUPADATA_KEY, but a
 * key must never end up in shell history, in a process listing, in a terminal
 * scrollback, or in git. This prompts with the echo suppressed and writes the
 * values to .env.development.local, which .gitignore already covers.
 *
 * It never prints a key. Confirmation is by length and a short SHA-256
 * fingerprint only, which is enough to tell two keys apart without revealing
 * either. Production credentials in Vercel are not touched.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, '.env.development.local');

const WANTED = [
  {
    name: 'GEMINI_KEY',
    hint: 'Google AI Studio / Gemini API key (extraction). Usually starts "AIza".',
    looksRight: v => v.length >= 20
  },
  {
    name: 'SUPADATA_KEY',
    hint: 'Supadata API key (transcript fallback — now the primary source).',
    looksRight: v => v.length >= 10
  }
];

const fingerprint = v => createHash('sha256').update(v).digest('hex').slice(0, 8);

/** Prompt with the typed characters masked. */
function askHidden(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;

    rl._writeToOutput = function (chunk) {
      if (muted) {
        // Show nothing at all rather than a fixed number of asterisks, so the
        // key length is not leaked to anyone looking at the screen.
        return;
      }
      rl.output.write(chunk);
    };

    rl.question(question, answer => {
      rl.output.write('\n');
      rl.close();
      resolve(answer.trim());
    });
    muted = true;
  });
}

function readExisting() {
  if (!fs.existsSync(TARGET)) return {};
  const out = {};
  for (const line of fs.readFileSync(TARGET, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}

function assertIgnored() {
  try {
    execFileSync('git', ['check-ignore', '-q', TARGET], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

console.log('\nLocal development credentials');
console.log('─'.repeat(60));
console.log(`Writing to: ${path.relative(ROOT, TARGET)}  (git-ignored, local only)`);
console.log('Input is hidden. Nothing you type is echoed, logged, or committed.');
console.log('Press Enter to leave a value unchanged.\n');

if (!assertIgnored()) {
  console.error('ABORTING: .env.development.local is not git-ignored. Fix .gitignore first.');
  process.exit(1);
}

const existing = readExisting();
const values = { ...existing };

for (const { name, hint, looksRight } of WANTED) {
  const has = Boolean(existing[name]);
  console.log(`${name}`);
  console.log(`  ${hint}`);
  if (has) console.log(`  currently set (len ${existing[name].length}, fp ${fingerprint(existing[name])})`);

  const entered = await askHidden(`  ${name}${has ? ' [Enter = keep]' : ''}: `);

  if (!entered) {
    if (!has) console.log('  skipped — not set\n');
    else console.log('  kept existing value\n');
    continue;
  }

  if (!looksRight(entered)) {
    console.log(`  WARNING: that looks unusually short (${entered.length} chars). Storing it anyway.`);
  }

  // A double-paste is easy to do and produces a key that authenticates
  // nowhere. Detect an exact doubling and offer to correct it, because the
  // resulting 401 can otherwise look like an invalid or expired key.
  let finalValue = entered;
  if (entered.length % 2 === 0) {
    const half = entered.slice(0, entered.length / 2);
    if (half + half === entered) {
      console.log('  NOTE: this value is exactly the same string twice, which usually');
      console.log('        means it was pasted twice. Using the single copy.');
      finalValue = half;
    }
  }

  values[name] = finalValue;
  console.log(`  stored (len ${finalValue.length}, fp ${fingerprint(finalValue)})\n`);
}

const body =
  '# Local development credentials for IoTutorMine.\n' +
  '# Git-ignored. Never commit. Production values live in Vercel and are separate.\n' +
  `# Written by scripts/set-local-secrets.mjs on ${new Date().toISOString()}\n\n` +
  Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';

fs.writeFileSync(TARGET, body, { mode: 0o600 });
try {
  fs.chmodSync(TARGET, 0o600);
} catch {
  /* best effort */
}

// chmod does not map onto Windows ACLs, so the file can still end up
// world-readable there. Drop inheritance and grant the current user only.
if (process.platform === 'win32') {
  try {
    execFileSync('icacls', [TARGET, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(F)`], {
      stdio: 'ignore'
    });
  } catch {
    console.log('  NOTE: could not tighten Windows permissions on the file automatically.');
  }
}

console.log('─'.repeat(60));
console.log('Saved. Summary (values never shown):\n');
for (const { name } of WANTED) {
  const v = values[name];
  console.log(`  ${name.padEnd(14)} ${v ? `set   len ${String(v.length).padEnd(4)} fp ${fingerprint(v)}` : 'NOT SET'}`);
}
console.log('\nRestart the local API to pick these up:');
console.log('  node scripts/dev-api.mjs\n');
