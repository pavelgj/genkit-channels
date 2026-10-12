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
 * Unit tests for the Discord channel's pure helpers (session keys, mention
 * stripping, message gathering). No network, no discord.js.
 *
 * The Discord channel is written in TypeScript; the bridge is compiled to
 * `test/.build/discord/` first by test/build-channel-units.mjs (see the
 * `test:units` npm script).
 *
 *   node test/discord-bridge.mjs
 */

import {
  deriveSessionKey,
  formatGatheredMessages,
  stripMention,
  turnMessages,
} from './.build/discord/bridge.js';


let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
}

// ── deriveSessionKey ────────────────────────────────────────────────────────
check(
  'DM session key is per-user',
  deriveSessionKey({ isDM: true, userId: 'u1', channelId: 'c1', id: 'm1' }) ===
    'discord:user:u1'
);
check(
  'channel session key uses thread when present',
  deriveSessionKey({
    isDM: false,
    userId: 'u1',
    channelId: 'c1',
    threadId: 't1',
    id: 'm1',
  }) === 'discord:channel:c1:thread:t1'
);
check(
  'channel session key falls back to message id',
  deriveSessionKey({ isDM: false, userId: 'u1', channelId: 'c1', id: 'm1' }) ===
    'discord:channel:c1:thread:m1'
);

// ── stripMention ────────────────────────────────────────────────────────────
check(
  'stripMention removes <@id>',
  stripMention('<@123> hello there', '123') === 'hello there'
);
check(
  'stripMention removes <@!id> (nickname form)',
  stripMention('hi <@!123>', '123') === 'hi'
);
check(
  'stripMention trims when botId unknown',
  stripMention('  spaced  ', undefined) === 'spaced'
);

// ── formatGatheredMessages ──────────────────────────────────────────────────
check(
  'gather attributes senders by default',
  formatGatheredMessages([
    { userName: 'alice', text: 'one' },
    { userName: 'bob', text: 'two' },
  ]) === '[alice]: one\n\n[bob]: two'
);
check(
  'gather can omit sender names',
  formatGatheredMessages([{ userName: 'alice', text: 'solo' }], {
    includeSenderName: false,
  }) === 'solo'
);
check(
  'gather skips empty messages',
  formatGatheredMessages([
    { userName: 'alice', text: '  ' },
    { userName: 'bob', text: 'real' },
  ]) === '[bob]: real'
);

// ── turnMessages ────────────────────────────────────────────────────────────
const m = (id, text = `t${id}`) => ({ id, userName: 'u', text });
check(
  'turn messages merge triggers and history, oldest first, once each',
  turnMessages([m('30'), m('50')], [m('20'), m('30'), m('40'), m('50')])
    .map((x) => x.id)
    .join() === '20,30,40,50'
);
check(
  'a trigger posted above the previous reply still counts',
  turnMessages([m('15'), m('60')], [m('60')], '10')
    .map((x) => x.id)
    .join() === '15,60'
);
check(
  'messages an earlier turn answered are left out',
  turnMessages([m('60')], [m('20'), m('40'), m('60')], '40')
    .map((x) => x.id)
    .join() === '60'
);
check(
  'snowflakes compare as numbers, not strings',
  turnMessages([m('100000000000000000002')], [m('99999999999999999999')])
    .map((x) => x.id)
    .join() === '99999999999999999999,100000000000000000002'
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll discord-bridge checks passed.');
