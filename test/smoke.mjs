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
 * Smoke test for the genkit-channels helper library. Exercises the full
 * reflection v2 round trip against the fake runtime: register, listActions,
 * non-streaming runAction, and streaming runAction. Run after `pnpm build`:
 *
 *   node test/smoke.mjs
 */

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

async function main() {
  const app = startAppProcess({
    child: { command: 'node', args: [fakeRuntime] },
    readyTimeoutMs: 10000,
  });

  await app.ready;
  console.log('child registered');

  const actions = await app.listActions();
  check('listActions returns echo flow', !!actions['/flow/echo']);
  check(
    'listActions returns weatherAgent agent',
    !!actions['/agent/weatherAgent']
  );

  // Non-streaming.
  const res = await app.runAction({
    key: '/flow/echo',
    input: { hello: 'world' },
  });
  check(
    'runAction echoes input',
    JSON.stringify(res.result.echoed) === JSON.stringify({ hello: 'world' })
  );
  check('runAction reports action key', res.result.action === '/flow/echo');

  // Streaming.
  const chunks = [];
  let sawTraceId = false;
  const streamed = await app.runAction({
    key: '/agent/weatherAgent',
    input: { q: 'weather?' },
    onChunk: (c) => chunks.push(c),
    onTraceId: () => {
      sawTraceId = true;
    },
  });
  check('streaming produced chunks', chunks.length === 3);
  check('streaming reported a trace id', sawTraceId);
  check(
    'streaming still returns a final result',
    streamed.result.action === '/agent/weatherAgent'
  );

  await app.stop();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll smoke checks passed.');
  process.exit(0);
}

main().catch((e) => {
  console.error('smoke test crashed:', e);
  process.exit(1);
});
