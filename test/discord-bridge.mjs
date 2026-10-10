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
 * stripping, truncation, message gathering). No network, no discord.js.
 *
 * The Discord channel is written in TypeScript; the bridge is compiled to
 * `test/.build/discord/` first by test/build-channel-units.mjs (see the
 * `test:units` npm script).
 *
 *   node test/discord-bridge.mjs
 */

import {
  MAX_DISCORD_LEN,
  deriveSessionKey,
  formatGatheredMessages,
  stripMention,
  truncate,
  uuidv5,
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

// ── uuidv5 ────────────────────────────────────────────────────────────────
const u1 = uuidv5('discord:user:42');
const u2 = uuidv5('discord:user:42');
const u3 = uuidv5('discord:user:99');
check('uuidv5 is deterministic', u1 === u2);
check('uuidv5 differs by input', u1 !== u3);
check(
  'uuidv5 is a valid v5 uuid',
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(u1)
);

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

// ── truncate ────────────────────────────────────────────────────────────────
check('truncate leaves short text', truncate('short') === 'short');
const long = 'x'.repeat(MAX_DISCORD_LEN + 50);
const cut = truncate(long);
check('truncate respects the limit', cut.length === MAX_DISCORD_LEN);
check('truncate appends an ellipsis', cut.endsWith('…'));

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

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll discord-bridge checks passed.');
