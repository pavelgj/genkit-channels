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
  missedMessages,
  ThreadTracker,
  sessionKey,
  stripMention,
  truncate,
  uuidv5,
} from './.build/slack-socket/bridge.js';
import { FAILURE_MESSAGE, REFUSED_MESSAGE, runTurn } from './.build/slack-socket/turn.js';
import { initChannel } from '../dist/index.js';
import { check, run } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const echoApp = path.join(here, 'fixtures', 'echo-app.mjs');
const BOT = 'UBOT';

async function bridge() {
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
  check('bare top-level mention is ignored', !mentionTrigger({ ...base, text: `<@${BOT}>` }, BOT));
  const bare = mentionTrigger({ ...base, threadTs: '99.0', text: `<@${BOT}> ` }, BOT);
  check('bare mention in a thread catches up', bare?.catchUp === true && bare.threadTs === '99.0');
  check('bot messages are ignored', !mentionTrigger({ ...base, botId: 'B1', text: `<@${BOT}> hi` }, BOT));
  check('own messages are ignored', !mentionTrigger({ ...base, user: BOT, text: `<@${BOT}> hi` }, BOT));

  const followed = new Set(['99.0']);
  const opts = { botUserId: BOT, followThreads: true, isFollowed: (t) => followed.has(t) };
  const msg = async (extra) => messageTrigger({ ...base, ...extra }, opts);
  const dm = await msg({ channel: 'D1', channelType: 'im', text: 'hello' });
  check('DMs trigger, threaded under the message', dm?.threadTs === '100.1' && dm.text === 'hello');
  check(
    'DM thread replies continue that thread',
    (await msg({ channel: 'D1', channelType: 'im', threadTs: '50.0', text: 'more' }))?.threadTs === '50.0'
  );
  check('channel chatter is ignored', !(await msg({ channelType: 'channel', text: 'chatter' })));
  check(
    'channel mentions are left to app_mention (no double reply)',
    !(await msg({ channelType: 'channel', threadTs: '99.0', text: `<@${BOT}> hi` }))
  );
  check(
    'replies in a followed thread trigger',
    (await msg({ channelType: 'channel', threadTs: '99.0', text: 'and tomorrow?' }))?.threadTs === '99.0'
  );
  check('replies in other threads are ignored', !(await msg({ channelType: 'channel', threadTs: '98.0', text: 'x' })));
  check(
    'followThreads: false ignores followed threads',
    !(await messageTrigger(
      { ...base, channelType: 'channel', threadTs: '99.0', text: 'x' },
      { ...opts, followThreads: false }
    ))
  );
  check('edits and other subtypes are ignored', !(await msg({ channelType: 'im', subtype: 'message_changed', text: 'x' })));
}

const BOT_ID = 'BBOT';
const me = { userId: BOT, botId: BOT_ID };

/** A fake conversations.replies that counts calls. */
function fakeSlack(threads, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    fetchThread: async (channel, ts) => {
      calls.push(`${channel}:${ts}`);
      await new Promise((r) => setTimeout(r, 5));
      return fail ? undefined : threads[`${channel}:${ts}`];
    },
  };
}

async function tracker() {
  const threads = {
    'C1:1.0': [
      { ts: '1.0', user: 'U1', text: `<@${BOT}> hi` },
      { ts: '1.1', user: BOT, botId: BOT_ID, text: 'hey' },
    ],
    'C1:2.0': [{ ts: '2.0', user: 'U1', text: 'not for the bot' }],
    // Bot replies identified only by bot_id (e.g. some app-posted messages).
    'C1:3.0': [{ ts: '3.0', user: 'U1' }, { ts: '3.1', botId: BOT_ID }],
  };
  const slack = fakeSlack(threads);
  const t = new ThreadTracker({ fetchThread: slack.fetchThread, bot: () => me });

  t.follow('C1', '9.0');
  check('followed threads answer from memory', t.isFollowed('C1', '9.0') === true && slack.calls.length === 0);

  const [a, b] = await Promise.all([t.isFollowed('C1', '1.0'), t.isFollowed('C1', '1.0')]);
  check('unknown thread with a bot reply is followed', a === true && b === true);
  check('concurrent lookups share one call', slack.calls.length === 1);
  check('the answer is remembered', t.isFollowed('C1', '1.0') === true && slack.calls.length === 1);

  check('unknown thread without the bot is not followed', (await t.isFollowed('C1', '2.0')) === false);
  check('a negative answer is remembered too', t.isFollowed('C1', '2.0') === false && slack.calls.length === 2);
  t.follow('C1', '2.0');
  check('a later mention flips it to followed', t.isFollowed('C1', '2.0') === true);
  check('bot_id alone identifies our replies', (await t.isFollowed('C1', '3.0')) === true);

  const down = fakeSlack(threads, { fail: true });
  const t2 = new ThreadTracker({ fetchThread: down.fetchThread, bot: () => me });
  check('a failed read means not followed', (await t2.isFollowed('C1', '1.0')) === false);
  check('failures are not retried per message', t2.isFollowed('C1', '1.0') === false && down.calls.length === 1);

  const small = new ThreadTracker({ fetchThread: slack.fetchThread, bot: () => me, maxEntries: 2 });
  small.follow('C', 'a');
  small.follow('C', 'b');
  small.follow('C', 'c');
  check('memory is bounded (oldest forgotten)', small.isFollowed('C', 'a') instanceof Promise);

  // The trigger only asks the tracker when it has to.
  const lazy = fakeSlack(threads);
  const t3 = new ThreadTracker({ fetchThread: lazy.fetchThread, bot: () => me });
  const opts = { botUserId: BOT, followThreads: true, isFollowed: (ts) => t3.isFollowed('C1', ts) };
  await messageTrigger({ channel: 'C1', channelType: 'channel', user: 'U1', ts: '5.0', text: 'top level' }, opts);
  await messageTrigger({ channel: 'D1', channelType: 'im', user: 'U1', ts: '5.1', threadTs: '1.0', text: 'dm' }, opts);
  await messageTrigger(
    { channel: 'C1', channelType: 'channel', user: 'U1', ts: '5.2', threadTs: '1.0', text: `<@${BOT}> x` },
    opts
  );
  check('top-level, DM and mention messages never read the thread', lazy.calls.length === 0);
  const after = await messageTrigger(
    { channel: 'C1', channelType: 'channel', user: 'U1', ts: '1.5', threadTs: '1.0', text: 'weather in NY?' },
    opts
  );
  check('after a restart, replies in a thread the bot was in trigger', after?.text === 'weather in NY?' && lazy.calls.length === 1);
}

function catchUp() {
  // The screenshot: a restart, two missed replies, then a bare mention.
  const thread = [
    { ts: '1.0', user: 'U1', text: `<@${BOT}> hi` },
    { ts: '1.1', user: BOT, botId: BOT_ID, text: 'Hey there!' },
    { ts: '1.2', user: 'U1', text: 'tell me a joke' },
    { ts: '1.3', user: BOT, botId: BOT_ID, text: 'Why do programmers...' },
    { ts: '1.4', user: 'U1', text: 'weather in new york?' },
    { ts: '1.5', user: 'U1', subtype: 'channel_join' },
    { ts: '1.6', user: 'U2', botId: 'BOTHER', text: 'another bot' },
    { ts: '1.7', user: 'U2', subtype: 'thread_broadcast', text: 'yo?' },
    { ts: '1.8', user: 'U1', text: `<@${BOT}>` },
  ];
  check(
    'catch-up collects user messages since the last reply',
    missedMessages(thread, me, '1.8') === 'weather in new york?\nyo?'
  );
  check('nothing missed gives empty input', missedMessages(thread.slice(0, 4), me) === '');
  check(
    'a thread the bot never replied in is taken whole',
    missedMessages([{ ts: '2.0', user: 'U1', text: 'question' }, { ts: '2.1', user: 'U1', text: `<@${BOT}>` }], me, '2.1') ===
      'question'
  );
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
      agent: (handle) =>
        channel.agent(agentState === 'server' ? 'echoAgent' : 'echoClientAgent', handle),
      context: () => channel.context({ input, channel: { platform: 'slack', user: { id: 'U1' } } }),
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

/** `expose.contextProvider`: the echo app lets `Bearer ok` through. */
async function guardedTurns() {
  const channel = initChannel({
    config: {
      expose: { agents: ['echoAgent'], contextProvider: 'auth' },
      box: { runner: { type: 'exec', cmd: ['node', echoApp] } },
    },
  });
  const turn = (headers, reply) =>
    runTurn({
      agent: (handle) => channel.agent('echoAgent', handle),
      // Slack has no headers; the test stands in for a provider that checks
      // something the caller sent (a real one would look at `channel.user`).
      context: () =>
        channel.context({ headers, input: 'hi', channel: { platform: 'slack', user: { id: 'U7' } } }),
      agentState: 'server',
      sessionKey: 'k',
      sessionId: uuidv5('guarded'),
      input: 'hi',
      reply,
      clientState: new Map(),
    });
  try {
    const ok = recorder();
    const res = await turn({ authorization: 'Bearer ok' }, ok.reply);
    check('[guarded] an allowed caller gets a reply', res?.text === 'echo:hi');

    const refused = recorder();
    const none = await turn({ authorization: 'Bearer nope' }, refused.reply);
    check(
      '[guarded] a refused caller gets the refusal, and nothing else',
      !none && refused.calls.length === 1 && refused.calls[0][1] === REFUSED_MESSAGE
    );
  } finally {
    await channel.close();
  }
}

run('slack', async () => {
  await bridge();
  await tracker();
  catchUp();
  await queue();
  await turns();
  await guardedTurns();
});
