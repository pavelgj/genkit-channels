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
 * Exercises the agent client (app.listAgents / app.getAgent) over the fake
 * runtime: agent discovery + capability metadata, a streaming turn driven
 * through the ergonomic AgentAPI, and both server- and client-managed state
 * paths. Run after `pnpm build`:
 *
 *   node test/agent.mjs
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

/** Drains a turn's stream, returning the concatenated chunk text. */
async function drain(turn) {
  let streamed = '';
  for await (const chunk of turn.stream) {
    if (chunk.text) streamed += chunk.text;
  }
  return streamed;
}

async function runServerManaged() {
  const app = startAppProcess({
    child: {
      command: 'node',
      args: [fakeRuntime],
      env: { FAKE_AGENT_STATE: 'server' },
    },
    readyTimeoutMs: 10000,
  });
  await app.ready;

  const agents = await app.listAgents();
  const echo = agents.find((a) => a.name === 'echoAgent');
  check('listAgents discovers echoAgent', !!echo);
  check('listAgents skips flows', !agents.some((a) => a.name === 'echo'));
  check('echoAgent reports server state', echo?.stateManagement === 'server');
  check('echoAgent reports abortable', echo?.abortable === true);

  const agent = await app.getAgent(echo.key);

  const chat = agent.chat({ sessionId: '11111111-1111-5111-8111-111111111111' });
  const turn = chat.sendStream('hello world');
  const streamed = await drain(turn);
  const res = await turn.response;

  check('server turn streamed chunks', streamed.includes('echo:'));
  check('server turn final text echoes input', res.text.includes('hello world'));
  check('server turn carries a snapshotId', !!res.snapshotId);

  // A follow-up turn on the same chat continues the session.
  const turn2 = chat.sendStream('again');
  await drain(turn2);
  const res2 = await turn2.response;
  check('server follow-up succeeds', res2.text.includes('again'));

  await app.stop();
}

async function runClientManaged() {
  const app = startAppProcess({
    child: {
      command: 'node',
      args: [fakeRuntime],
      env: { FAKE_AGENT_STATE: 'client' },
    },
    readyTimeoutMs: 10000,
  });
  await app.ready;

  const agents = await app.listAgents();
  const echo = agents.find((a) => a.name === 'echoAgent');
  check('client echoAgent reports client state', echo?.stateManagement === 'client');

  const agent = await app.getAgent(echo.key);

  // First turn: no prior state.
  const chat = agent.chat();
  const turn = chat.sendStream('first');
  await drain(turn);
  const res = await turn.response;
  check('client turn returns state on the wire', res.raw?.state !== undefined);
  const saved = res.raw.state;
  check('client state carries messages', (saved.messages?.length ?? 0) >= 2);

  // Second turn: round-trip the saved state blob into a fresh chat.
  const chat2 = agent.chat({ state: saved });
  const turn2 = chat2.sendStream('second');
  await drain(turn2);
  const res2 = await turn2.response;
  check(
    'client round-trip accumulates history',
    (res2.raw.state.messages?.length ?? 0) > (saved.messages?.length ?? 0)
  );

  await app.stop();
}

async function main() {
  await runServerManaged();
  await runClientManaged();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll agent-client checks passed.');
  process.exit(0);
}

main().catch((e) => {
  console.error('agent test crashed:', e);
  process.exit(1);
});
