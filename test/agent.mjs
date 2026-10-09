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
 * Agent proxies over the fake runtime: `channel.agent()` returns a box agent
 * proxy synchronously, and both server- and client-managed state work through
 * the standard AgentAPI. Run after `pnpm build`:
 *
 *   node test/agent.mjs
 */

import { initChannel } from '../dist/index.js';
import { check, drain, fakeRuntimeCmd, run } from './helpers.mjs';

function openChannel(agentState) {
  // FAKE_AGENT_STATE is read by the fake runtime, which inherits our env.
  process.env.FAKE_AGENT_STATE = agentState;
  return initChannel({
    config: {
      expose: { agents: ['echoAgent'] },
      agentState: { echoAgent: agentState },
      box: { runner: { type: 'exec', cmd: fakeRuntimeCmd } },
    },
  });
}

async function serverManaged() {
  const channel = openChannel('server');
  check('agentState reads config', channel.agentState('echoAgent') === 'server');

  // No name: the single exposed agent. Sync, nothing started yet.
  const agent = channel.agent();
  check('agent() returns an AgentAPI synchronously', typeof agent.chat === 'function');

  const chat = agent.chat({ sessionId: 'session-a' });
  const turn = chat.sendStream('hello world');
  const streamed = await drain(turn);
  const res = await turn.response;
  check('server turn streamed chunks', streamed.includes('echo:'));
  check('server turn final text echoes input', res.text.includes('hello world'));
  check('server turn carries a snapshotId', !!res.snapshotId);

  // The chat resumes by snapshotId on the next turn.
  const res2 = await chat.send('again');
  check('server follow-up succeeds', res2.text.includes('again'));

  const snap = await agent.getSnapshot({ sessionId: 'session-a' });
  check('getSnapshot sees both turns', snap?.state?.messages?.length === 4);

  await channel.close();
}

async function clientManaged() {
  const channel = openChannel('client');
  const agent = channel.agent('echoAgent');

  const res = await agent.chat().send('first');
  const saved = res.raw.state;
  check('client turn returns state on the wire', saved !== undefined);
  check('client state carries messages', (saved?.messages?.length ?? 0) >= 2);

  const res2 = await agent.chat({ state: saved }).send('second');
  check(
    'client round-trip accumulates history',
    (res2.raw.state?.messages?.length ?? 0) > (saved?.messages?.length ?? 0)
  );

  await channel.close();
}

async function errors() {
  const none = initChannel({
    config: { box: { runner: { type: 'exec', cmd: 'true' } } },
  });
  let threw = false;
  try {
    none.agent();
  } catch (e) {
    threw = /No agent exposed/.test(e.message);
  }
  check('agent() with nothing exposed throws a helpful error', threw);
  await none.close();
}

run('agent', async () => {
  await serverManaged();
  await clientManaged();
  await errors();
});
