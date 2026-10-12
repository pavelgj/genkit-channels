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
 * genkit-channels/chat: splitMessage, messageRenderer, StreamSplitter and
 * session ids. Conversations (turns, coalescing, the store) are in
 * test/conversations.mjs. Run after `pnpm build`:
 *
 *   node test/chat.mjs
 */

import {
  messageRenderer,
  sessionId,
  splitMessage,
  StreamSplitter,
} from '../dist/chat/index.js';
import { check, run } from './helpers.mjs';

function splitting() {
  check('short text is one part', JSON.stringify(splitMessage('  hi  ', 100)) === '["hi"]');

  const paras = ['a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)].join('\n\n');
  const p = splitMessage(paras, 70);
  check(
    'splits on paragraph breaks',
    p.length === 2 && p[0] === `${'a'.repeat(30)}\n\n${'b'.repeat(30)}` && p[1] === 'c'.repeat(30)
  );

  const words = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
  const w = splitMessage(words, 50);
  check('falls back to spaces', w.every((s) => s.length <= 50) && w.join(' ') === words);

  const long = 'x'.repeat(250);
  const l = splitMessage(long, 100);
  check('cuts a word longer than a message', l.every((s) => s.length <= 100) && l.join('') === long);

  const emoji = '\u{1F600}'.repeat(60);
  const e = splitMessage(emoji, 45);
  check('never splits a surrogate pair', e.every((s) => !/[\ud800-\udbff]$/.test(s)) && e.join('') === emoji);

  const lines = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`);
  const code = ['Here:', '```ts', ...lines, '```', 'Done.'].join('\n');
  const c = splitMessage(code, 120);
  check('every part fits', c.every((s) => s.length <= 120));
  check(
    'a split code block is closed and reopened with its language',
    c.length > 1 && c[0].endsWith('\n```') && c[1].startsWith('```ts\n')
  );
  const fences = (s) => (s.match(/^```/gm) ?? []).length;
  check('every part has balanced fences', c.every((s) => fences(s) % 2 === 0));
  check('no code is lost', lines.every((line) => c.some((s) => s.includes(line))));
  check('text after the block survives', c.at(-1).endsWith('Done.'));

  let threw = false;
  try {
    splitMessage('x', 10);
  } catch {
    threw = true;
  }
  check('rejects a maxLen too small for a reopened fence', threw);
}

async function renderer() {
  const ops = [];
  let n = 0;
  const out = messageRenderer(
    {
      post: async (text) => {
        ops.push(['post', text]);
        return ++n;
      },
      edit: async (id, text) => void ops.push(['edit', id, text]),
    },
    50
  );
  let text = '';
  for (let i = 0; i < 12; i++) {
    text += `word${i} `;
    await out.render(text);
  }
  check('a growing reply posts a second message past the limit', out.posted === 2);
  check(
    'later text edits the second message, not a repost',
    ops.filter((o) => o[0] === 'post').length === 2 && ops.some((o) => o[0] === 'edit' && o[1] === 2)
  );
  const before = ops.length;
  await out.render(text);
  check('unchanged text makes no calls', ops.length === before);
}

function streamSplitting() {
  const s = new StreamSplitter(50);
  const messages = [''];
  const feed = (delta) => {
    const [head, ...more] = s.push(delta);
    messages[messages.length - 1] += head;
    messages.push(...more);
  };
  const words = Array.from({ length: 30 }, (_, i) => `word${i} `);
  for (const w of words) feed(w);
  check('a streamed reply moves to a new message at the limit', messages.length > 1);
  check('every streamed message fits', messages.every((m) => m.length <= 50));
  check('no streamed text is lost', messages.join(' ').replace(/\s+/g, ' ').trim() === words.join('').trim());
  check('words that arrived whole are never cut', messages.every((m) => /^(word\d+ ?)+$/.test(m.trim() + ' ')));

  const big = new StreamSplitter(50).push('y'.repeat(120));
  check(
    'one huge chunk is cut with no empty messages',
    big.length === 3 && big.every((m) => m.length > 0 && m.length <= 50) && big.join('') === 'y'.repeat(120)
  );

  const c = new StreamSplitter(60);
  const cm = [''];
  for (const d of ['```py\n', ...Array.from({ length: 10 }, (_, i) => `x${i} = ${i}\n`), '```\n']) {
    const [head, ...more] = c.push(d);
    cm[cm.length - 1] += head;
    cm.push(...more);
  }
  check(
    'a streamed code block is closed and reopened',
    cm.length > 1 && cm[0].endsWith('\n```') && cm[1].startsWith('```py\n') && cm.every((m) => m.length <= 60)
  );
}

function sessions() {
  // The ids the Slack and Discord bridges produced before the move, so
  // existing conversations keep their sessions.
  check('session ids are unchanged (discord)', sessionId('discord:user:42') === '9c8afae6-76b8-51b4-9553-2cb0d366cead');
  check('session ids are unchanged (slack)', sessionId('slack:T:C:1.2') === 'ff636bfd-f753-5d29-9c94-5c758e8f4a22');
  check('different keys, different ids', sessionId('a') !== sessionId('b'));
}

run('chat', async () => {
  splitting();
  await renderer();
  streamSplitting();
  sessions();
});
