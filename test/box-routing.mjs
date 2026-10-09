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
 *  - route: session gives each agent session its own box, and snapshot-only
 *    calls (resume, getSnapshot) find their way back (FR-3 shim),
 *  - box.env / denyEnv control what the box inherits (FR-1 shim).
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
  const agent = channel.agent();

  // Two sessions, two turns each. Second turns resume by snapshotId only, so
  // they must route via the snapshot -> box mapping.
  const a = agent.chat({ sessionId: 'session-a' });
  const b = agent.chat({ sessionId: 'session-b' });
  await a.send('a1');
  await b.send('b1');
  await a.send('a2');
  await b.send('b2');

  const snapA = await agent.getSnapshot({ sessionId: 'session-a' });
  const snapB = await agent.getSnapshot({ sessionId: 'session-b' });
  check('session a kept its history across turns', snapA?.state?.messages?.length === 4);
  check('session b kept its history across turns', snapB?.state?.messages?.length === 4);
  check(
    'each session ran in its own box',
    !!snapA?.pid && !!snapB?.pid && snapA.pid !== snapB.pid
  );

  const bySnapshot = await agent.getSnapshot(a.snapshotId);
  check('snapshot-only lookup routes to its session', bySnapshot?.pid === snapA?.pid);

  // No session id up front: the box mints one and later calls route back.
  const fresh = agent.chat();
  await fresh.send('hi');
  await fresh.send('again');
  const snapFresh = await agent.getSnapshot({ sessionId: fresh.sessionId });
  check('agent-minted session keeps routing to its box', snapFresh?.state?.messages?.length === 4);

  // Flows have no session: they share one box instead of one per call.
  const probe = channel.flow('probe');
  const p1 = await probe.run({});
  const p2 = await probe.run({});
  check('session route: flows share one box', p1.result.pid === p2.result.pid);
  check(
    'session route: the flow box is not a session box',
    p1.result.pid !== snapA?.pid && p1.result.pid !== snapB?.pid
  );

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
