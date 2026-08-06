/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Attached-mode smoke test: the sidecar packaging path in miniature.
 *
 * Instead of spawning the child itself (managed mode), the channel helper binds
 * a *fixed* WS port and waits for a separately started runtime to dial in, the
 * way the user-app sidecar container would on Cloud Run. This validates the
 * attached branch of startAppProcess and the fixed-port binding without any
 * containers.
 *
 * Run after `pnpm build`:
 *   node test/smoke-attached.mjs
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAppProcess } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeRuntime = path.join(here, 'fake-runtime.mjs');

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
}

/** Finds a free TCP port to use as the fixed attach port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function main() {
  const port = await freePort();

  // Attached mode: no child, bind a known port and wait for a dial-in.
  const app = startAppProcess({ port, readyTimeoutMs: 10000 });
  check('attached server binds the requested port', app.wsUrl.endsWith(`:${port}`));


  // Start the runtime separately, pointing it at the fixed port (this is what
  // the sidecar container's env does).
  const child = spawn('node', [fakeRuntime], {
    env: {
      ...process.env,
      GENKIT_ENV: 'dev',
      GENKIT_REFLECTION_V2_SERVER: `ws://127.0.0.1:${port}`,
    },
    stdio: 'inherit',
  });

  try {
    await app.ready;
    console.log('runtime dialed in and registered');


    const actions = await app.listActions();
    check('listActions works over attached link', !!actions['/flow/echo']);

    const res = await app.runAction({
      key: '/flow/echo',
      input: { hello: 'sidecar' },
    });
    check(
      'runAction works over attached link',
      JSON.stringify(res.result.echoed) === JSON.stringify({ hello: 'sidecar' })
    );
  } finally {
    child.kill('SIGTERM');
    await app.stop();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll attached-mode smoke checks passed.');
  process.exit(0);
}

main().catch((e) => {
  console.error('attached smoke test crashed:', e);
  process.exit(1);
});
