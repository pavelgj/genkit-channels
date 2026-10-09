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
 * The `box` block end to end, against the fake runtime:
 *  - route: session (box's sessionRoute) gives each conversation its own box
 *    when the channel passes a per-conversation handle
 *    (`channel.agent(name, { sessionId })`),
 *  - box.env / denyEnv control what the box inherits (box `inheritEnv`).
 * Run after `pnpm build`:
 *
 *   node test/box-routing.mjs
 */

import { initChannel } from '../dist/index.js';
import { check, fakeRuntimeCmd, run } from './helpers.mjs';

async function sessionRouting() {
  process.env.FAKE_AGENT_STATE = 'server';
  const channel = initChannel({
    config: {
      expose: { agents: ['echoAgent'], flows: ['probe'] },
      box: { runner: { type: 'exec', cmd: fakeRuntimeCmd }, route: 'session' },
    },
  });

  // One handle per conversation, carrying its session id: every call through
  // it (later turns resume by snapshotId only) goes to the same box.
  const conversation = (sessionId) => {
    const agent = channel.agent('echoAgent', { sessionId });
    return { agent, chat: agent.chat({ sessionId }) };
  };
  const a = conversation('session-a');
  const b = conversation('session-b');
  await a.chat.send('a1');
  await b.chat.send('b1');
  await a.chat.send('a2');
  await b.chat.send('b2');

  const snapA = await a.agent.getSnapshot({ sessionId: 'session-a' });
  const snapB = await b.agent.getSnapshot({ sessionId: 'session-b' });
  check('session a kept its history across turns', snapA?.state?.messages?.length === 4);
  check('session b kept its history across turns', snapB?.state?.messages?.length === 4);
  check(
    'each session ran in its own box',
    !!snapA?.pid && !!snapB?.pid && snapA.pid !== snapB.pid
  );

  const bySnapshot = await a.agent.getSnapshot(a.chat.snapshotId);
  check('snapshot-only lookup on the handle routes to its session', bySnapshot?.pid === snapA?.pid);

  // Flows have no session: they share one box.
  const probe = channel.flow('probe');
  const p1 = await probe.run({});
  const p2 = await probe.run({});
  check('session route: flows share one box', p1.result.pid === p2.result.pid);
  check(
    'session route: the flow box is not a session box',
    p1.result.pid !== snapA?.pid && p1.result.pid !== snapB?.pid
  );

  // warm() starts the shared box (the one flows use), not a new one.
  await channel.warm();
  const p3 = await probe.run({});
  check('warm() targets the shared box', p3.result.pid === p1.result.pid);

  // Without a per-conversation handle, routing only sees the payload: a
  // snapshot-only call lands on the shared box, which doesn't know it. That is
  // why channels pass sessionId to channel.agent().
  const bare = channel.agent('echoAgent');
  const missed = await bare.getSnapshot(a.chat.snapshotId);
  check('bare handle: snapshot-only call goes to the shared box', missed === undefined);

  await channel.close();
}

async function envPolicy() {
  process.env.CHANNEL_SECRET = 'do-not-leak';
  process.env.APP_KEY = 'app-needs-this';
  process.env.OTHER_VAR = 'unlisted';
  const names = ['CHANNEL_SECRET', 'APP_KEY', 'OTHER_VAR', 'PATH'];

  const probe = async (box) => {
    const channel = initChannel({
      config: {
        expose: { flows: ['probe'] },
        box: { runner: { type: 'exec', cmd: fakeRuntimeCmd }, ...box },
      },
    });
    const { result } = await channel.flow('probe').run({ env: names });
    await channel.close();
    return result.env;
  };

  const inherited = await probe({});
  check('without a policy the box inherits everything', inherited.CHANNEL_SECRET === true);

  const denied = await probe({ denyEnv: ['CHANNEL_SECRET'] });
  check('denyEnv hides a var from the box', denied.CHANNEL_SECRET === false);
  check('denyEnv leaves others inherited', denied.OTHER_VAR === true);

  const allowed = await probe({ env: ['APP_KEY'] });
  check('env allowlist passes listed vars', allowed.APP_KEY === true);
  check('env allowlist drops unlisted vars', allowed.OTHER_VAR === false);
  check('env allowlist drops channel secrets', allowed.CHANNEL_SECRET === false);
  check('env allowlist keeps basics like PATH', allowed.PATH === true);
}

run('box-routing', async () => {
  await sessionRouting();
  await envPolicy();
});
