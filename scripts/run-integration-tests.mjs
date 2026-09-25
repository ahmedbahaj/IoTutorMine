#!/usr/bin/env node
/**
 * Runs the integration suite against a REAL Supabase instance.
 *
 * By default it targets the local stack started by `npx supabase start` and
 * reads its connection details from `supabase status`, so no keys are ever
 * written to disk or passed on the command line.
 *
 * To run against a hosted project instead, export SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY yourself and this script will use them as-is.
 */

import { spawn, spawnSync } from 'node:child_process';

const TEST_GLOB = 'tests/integration/*.test.js';

function localStackEnv() {
  // Node refuses to spawn .cmd shims without a shell on Windows.
  const result = spawnSync(
    'npx',
    ['--yes', 'supabase@latest', 'status', '-o', 'env'],
    { encoding: 'utf8', shell: process.platform === 'win32' }
  );

  if (result.status !== 0) {
    if (result.stderr) console.error(result.stderr.trim());
    return null;
  }

  const values = {};
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^([A-Z_]+)="(.*)"$/);
    if (match) values[match[1]] = match[2];
  }

  if (!values.API_URL || !values.SERVICE_ROLE_KEY) return null;

  return {
    SUPABASE_URL: values.API_URL,
    SUPABASE_SERVICE_ROLE_KEY: values.SERVICE_ROLE_KEY,
    SUPABASE_ANON_KEY: values.ANON_KEY
  };
}

let env = { ...process.env };

if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log(`Using the Supabase instance from the environment: ${env.SUPABASE_URL}`);
} else {
  const local = localStackEnv();

  if (!local) {
    console.error(
      'No Supabase instance found.\n' +
      'Either start the local stack:  npx supabase start\n' +
      'or export SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for a hosted project.'
    );
    process.exit(1);
  }

  console.log(`Using the local Supabase stack: ${local.SUPABASE_URL}`);
  env = { ...env, ...local };
}

const child = spawn(process.execPath, ['--test', TEST_GLOB], { env, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
