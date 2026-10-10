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
 * The Slack channel without Slack: trigger rules, session keys, per-thread
 * serialization, and full turns against the real echo app (server- and
 * client-managed) streamed into a recording Reply. The channel's bridge and
 * turn modules are compiled to `test/.build/` first by
 * test/build-channel-units.mjs.
 *
 *   npm run test:units
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KeyedQueue,
  MAX_MARKDOWN_LEN,
  mentionTrigger,
  messageTrigger,
  sessionKey,
  stripMention,
  truncate,
  uuidv5,
} from './.build/slack-socket/bridge.js';
import { FAILURE_MESSAGE, runTurn } from './.build/slack-socket/turn.js';
import { initChannel } from '../dist/index.js';
import { check, run } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const echoApp = path.join(here, 'fixtures', 'echo-app.mjs');
const BOT = 'UBOT';

function bridge() {
  check('stripMention removes <@BOT>', stripMention(`<@${BOT}> hi`, BOT) === 'hi');
  check('stripMention removes labelled mentions', stripMention(`hey <@${BOT}|genkit>`, BOT) === 'hey');
  check('stripMention keeps other users', stripMention(`<@UOTHER> hi`, BOT) === '<@UOTHER> hi');
  check('truncate respects the limit', truncate('x'.repeat(MAX_MARKDOWN_LEN + 5)).length === MAX_MARKDOWN_LEN);
  check('uuidv5 is stable', uuidv5(sessionKey('T', 'C', '1.2')) === uuidv5(sessionKey('T', 'C', '1.2')));
  check('threads get distinct sessions', uuidv5(sessionKey('T', 'C', '1.2')) !== uuidv5(sessionKey('T', 'C', '1.3')));

  const base = { channel: 'C1', user: 'U1', ts: '100.1' };
  const t1 = mentionTrigger({ ...base, text: `<@${BOT}> weather?` }, BOT);
  check('mention at top level threads under the message', t1?.threadTs === '100.1' && t1.text === 'weather?');
  const t2 = mentionTrigger({ ...base, threadTs: '99.0', text: `<@${BOT}> and now?` }, BOT);
  check('mention in a thread stays in that thread', t2?.threadTs === '99.0');
  check('empty mention is ignored', !mentionTrigger({ ...base, text: `<@${BOT}>` }, BOT));
  check('bot messages are ignored', !mentionTrigger({ ...base, botId: 'B1', text: `<@${BOT}> hi` }, BOT));
  check('own messages are ignored', !mentionTrigger({ ...base, user: BOT, text: `<@${BOT}> hi` }, BOT));

  const followed = new Set(['99.0']);
  const opts = { botUserId: BOT, followThreads: true, isFollowed: (t) => followed.has(t) };
  const msg = (extra) => messageTrigger({ ...base, ...extra }, opts);
  const dm = msg({ channel: 'D1', channelType: 'im', text: 'hello' });
  check('DMs trigger, threaded under the message', dm?.threadTs === '100.1' && dm.text === 'hello');
  check(
    'DM thread replies continue that thread',
    msg({ channel: 'D1', channelType: 'im', threadTs: '50.0', text: 'more' })?.threadTs === '50.0'
  );
  check('channel chatter is ignored', !msg({ channelType: 'channel', text: 'chatter' }));
  check(
    'channel mentions are left to app_mention (no double reply)',
    !msg({ channelType: 'channel', threadTs: '99.0', text: `<@${BOT}> hi` })
  );
  check(
    'replies in a followed thread trigger',
    msg({ channelType: 'channel', threadTs: '99.0', text: 'and tomorrow?' })?.threadTs === '99.0'
  );
  check('replies in other threads are ignored', !msg({ channelType: 'channel', threadTs: '98.0', text: 'x' }));
  check(
    'followThreads: false ignores followed threads',
    !messageTrigger(
      { ...base, channelType: 'channel', threadTs: '99.0', text: 'x' },
      { ...opts, followThreads: false }
    )
  );
  check('edits and other subtypes are ignored', !msg({ channelType: 'im', subtype: 'message_changed', text: 'x' }));
}

async function queue() {
  const q = new KeyedQueue();
  const order = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await Promise.all([
    q.run('a', async () => {
      await sleep(30);
      order.push('a1');
    }),
    q.run('a', async () => order.push('a2')),
    q.run('b', async () => order.push('b1')),
  ]);
  check('same thread runs in order', order.indexOf('a1') < order.indexOf('a2'));
  check('other threads run in parallel', order[0] === 'b1');
  const failed = q
    .run('c', async () => {
      throw new Error('boom');
    })
    .then(() => false, () => true);
  let ranAfter = false;
  await q.run('c', async () => {
    ranAfter = true;
  });
  check('a failed turn does not block the thread', (await failed) && ranAfter);
}

/** A Reply that records calls, optionally failing on append. */
function recorder({ failAppend = false } = {}) {
  const calls = [];
  return {
    calls,
    text: () => calls.filter((c) => c[0] === 'append').map((c) => c[1]).join(''),
    reply: {
      thinking: async () => calls.push(['thinking']),
      append: async (t) => {
        if (failAppend) throw new Error('slack said no');
        calls.push(['append', t]);
      },
      finish: async (t) => calls.push(['finish', t]),
      fail: async (m) => calls.push(['fail', m]),
    },
  };
}

async function turns() {
  const channel = initChannel({
    config: {
      expose: { agents: ['echoAgent', 'echoClientAgent'] },
      box: { runner: { type: 'exec', cmd: ['node', echoApp] } },
    },
  });
  const clientState = new Map();
  const turn = (agentState, key, input, reply) => {
    const sessionId = uuidv5(key);
    return runTurn({
      agent: channel.agent(agentState === 'server' ? 'echoAgent' : 'echoClientAgent', {
        sessionId,
      }),
      agentState,
      sessionKey: key,
      sessionId,
      input,
      reply,
      clientState,
    });
  };
  try {
    const key = sessionKey('T', 'C', '1.0');
    const r1 = recorder();
    const res1 = await turn('server', key, 'hi', r1.reply);
    check('[server] thinking comes first', r1.calls[0][0] === 'thinking');
    check('[server] text streams', r1.text() === 'echo:hi');
    check(
      '[server] finish gets the full reply',
      r1.calls.at(-1)[0] === 'finish' && r1.calls.at(-1)[1] === 'echo:hi'
    );
    check('[server] the session id comes from the thread', res1?.sessionId === uuidv5(key));

    const res2 = await turn('server', key, 'again', recorder().reply);
    const snap = await channel
      .agent('echoAgent', { sessionId: uuidv5(key) })
      .getSnapshot({ sessionId: uuidv5(key) });
    check(
      '[server] the next message resumes the session',
      res2?.sessionId === uuidv5(key) && snap?.state?.messages?.length === 4
    );
    check('[server] no client state is kept', clientState.size === 0);

    // Client-managed: the channel carries state between turns.
    const ckey = sessionKey('T', 'C', '2.0');
    await turn('client', ckey, 'one', recorder().reply);
    check('[client] state is stored per thread', clientState.has(ckey));
    const res4 = await turn('client', ckey, 'two', recorder().reply);
    check('[client] the next turn sees the history', res4?.raw.state?.messages?.length >= 4);

    const r5 = recorder({ failAppend: true });
    const res5 = await turn('server', key, 'x', r5.reply);
    check(
      'a failed reply reports to the user',
      !res5 && r5.calls.some((c) => c[0] === 'fail' && c[1] === FAILURE_MESSAGE)
    );
  } finally {
    await channel.close();
  }
}

run('slack', async () => {
  bridge();
  await queue();
  await turns();
});
