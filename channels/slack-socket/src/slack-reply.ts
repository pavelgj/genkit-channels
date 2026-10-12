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
 * {@link Reply} implementations on the Slack Web API. Both post into a thread
 * and send the model's markdown as `markdown_text`, so there is no conversion
 * to Slack's mrkdwn.
 *
 *  - native: Slack's text streaming (`chat.startStream` / `appendStream` /
 *    `stopStream`, via the SDK's `chatStream` helper, which buffers appends).
 *  - edit: post once, then debounced `chat.update`. For workspaces where
 *    native streaming isn't available.
 *
 * Both move on to a new message in the thread once the reply passes Slack's
 * per-message limit, so long replies arrive whole instead of cut off.
 */

import type { webApi } from '@slack/bolt';
import { messageRenderer, StreamSplitter } from 'genkit-channels/chat';
import type { Reply } from './turn.js';

type WebClient = webApi.WebClient;
type Streamer = ReturnType<WebClient['chatStream']>;

/** Slack's limit for `markdown_text` in a single call. */
export const MAX_MARKDOWN_LEN = 12_000;

export interface ReplyTarget {
  channel: string;
  threadTs: string;
  /** The user being answered (native streaming needs it outside DMs). */
  user?: string;
  team?: string;
}

/** "is thinking..." in the thread; cleared by Slack when the bot replies. */
async function setThinking(client: WebClient, t: ReplyTarget): Promise<void> {
  await client.assistant.threads.setStatus({
    channel_id: t.channel,
    thread_ts: t.threadTs,
    status: 'is thinking...',
  });
}

export function nativeStreamReply(
  client: WebClient,
  t: ReplyTarget,
  maxLen = MAX_MARKDOWN_LEN
): Reply {
  const open = (): Streamer =>
    client.chatStream({
      channel: t.channel,
      thread_ts: t.threadTs,
      recipient_user_id: t.user,
      recipient_team_id: t.team,
    });
  // Streams can only be appended to, so a long reply continues in a new
  // stream (a new message) once the current one is full.
  const splitter = new StreamSplitter(maxLen);
  let streamer = open();
  let started = false;

  const append = async (text: string): Promise<void> => {
    const [head, ...more] = splitter.push(text);
    if (head) {
      started = true;
      await streamer.append({ markdown_text: head });
    }
    for (const piece of more) {
      await streamer.stop();
      streamer = open();
      started = !!piece;
      if (piece) await streamer.append({ markdown_text: piece });
    }
  };

  return {
    thinking: () => setThinking(client, t),
    append,
    async finish(fullText) {
      if (!started) {
        // Nothing streamed (e.g. a tool-only turn that ends with text in the
        // final response): send the whole thing now.
        const text = fullText.trim();
        if (!text) return;
        await append(text);
      }
      await streamer.stop();
    },
    async fail(message) {
      if (started) {
        await streamer.append({ markdown_text: `\n\n_${message}_` });
        await streamer.stop();
      } else {
        await client.chat.postMessage({
          channel: t.channel,
          thread_ts: t.threadTs,
          text: message,
        });
      }
    },
  };
}

export function editReply(
  client: WebClient,
  t: ReplyTarget,
  intervalMs: number,
  maxLen = MAX_MARKDOWN_LEN
): Reply {
  const out = messageRenderer<string>(
    {
      async post(markdown_text) {
        const res = await client.chat.postMessage({
          channel: t.channel,
          thread_ts: t.threadTs,
          markdown_text,
        });
        if (!res.ts) throw new Error('chat.postMessage returned no ts');
        return res.ts;
      },
      async edit(ts, markdown_text) {
        await client.chat.update({ channel: t.channel, ts, markdown_text });
      },
    },
    maxLen
  );
  let text = '';
  let lastEdit = 0;

  const render = async (force: boolean): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastEdit < intervalMs) return;
    if (!text.trim()) return;
    lastEdit = now;
    await out.render(text);
  };

  return {
    thinking: () => setThinking(client, t),
    async append(chunk) {
      text += chunk;
      await render(false);
    },
    async finish(fullText) {
      text = fullText;
      await render(true);
    },
    async fail(message) {
      text = text.trim() ? `${text}\n\n_${message}_` : message;
      await render(true);
    },
  };
}
