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

/** Closes a code block that a split left open. */
const CLOSE_FENCE = '\n```';
/** Below this a message can't fit a reopened fence plus some text. */
const MIN_MAX_LEN = 40;

/**
 * Splits markdown into messages of at most `maxLen` characters, preferring
 * paragraph breaks, then line breaks, then spaces, and cutting mid-word only
 * when a single word is longer than a message. A split inside a code block
 * closes the block and reopens it (same language) in the next message.
 *
 * Only the first `maxLen` characters decide where the first cut goes, so a
 * streamed reply re-split as it grows keeps its earlier messages stable.
 */
export function splitMessage(text: string, maxLen: number): string[] {
  if (maxLen < MIN_MAX_LEN) {
    throw new Error(`splitMessage: maxLen must be at least ${MIN_MAX_LEN}`);
  }
  const parts: string[] = [];
  let rest = text.trim();
  // The fence line (e.g. "```ts") to reopen at the start of the next part.
  let reopen: string | undefined;
  while (rest) {
    const body = reopen ? `${reopen}\n${rest}` : rest;
    if (body.length <= maxLen) {
      parts.push(body);
      break;
    }
    // Leave room to close a code block, and never cut inside the reopened
    // fence line, or the loop would make no progress.
    const budget = maxLen - CLOSE_FENCE.length;
    const floor = reopen ? reopen.length + 1 : 0;
    const { end, next } = findCut(body, budget, floor);
    let chunk = body.slice(0, end).trimEnd();
    const open = openFence(chunk);
    if (open) chunk += CLOSE_FENCE;
    parts.push(chunk);
    reopen = open;
    rest = body.slice(next).replace(/^\n+/, '');
    // A block that ends right at the cut would reopen only to close again.
    if (reopen && /^```\s*(\n|$)/.test(rest)) {
      reopen = undefined;
      rest = rest.replace(/^```\s*/, '').replace(/^\n+/, '');
    }
  }
  return parts;
}

/** Where to end this part (`end`) and start the next one (`next`). */
function findCut(
  body: string,
  budget: number,
  floor: number
): { end: number; next: number } {
  const window = body.slice(0, budget + 1);
  for (const sep of ['\n\n', '\n', ' ']) {
    const at = window.lastIndexOf(sep);
    if (at > floor) return { end: at, next: at + sep.length };
  }
  // One word longer than a message: cut it, but not between the two halves
  // of a surrogate pair.
  const code = body.charCodeAt(budget - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? budget - 1 : budget;
  return { end, next: end };
}

/** The opening fence line if `text` ends inside a code block. */
function openFence(text: string): string | undefined {
  let open: string | undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('```')) continue;
    open = open ? undefined : trimmed;
  }
  return open;
}

/**
 * Splits a reply that can only be appended to (Slack's native streaming)
 * into messages of at most `maxLen`. Each `push` returns the pieces for one
 * delta: the first goes onto the current message, and each further piece
 * starts a new message. Cuts prefer a line break, then a space, inside the
 * delta, and code blocks are closed and reopened across the cut.
 */
export class StreamSplitter {
  private current = '';

  constructor(private readonly maxLen: number) {
    if (maxLen < MIN_MAX_LEN) {
      throw new Error(`StreamSplitter: maxLen must be at least ${MIN_MAX_LEN}`);
    }
  }

  push(delta: string): string[] {
    const out = [''];
    const budget = this.maxLen - CLOSE_FENCE.length;
    let rest = delta;
    // True while the current message holds only what a split put there (a
    // reopened fence), so deferring the whole delta would make no progress.
    let fresh = false;
    while (this.current.length + rest.length > budget) {
      const room = budget - this.current.length;
      const { end, next } = cutDelta(rest, room, !fresh && this.current.length > 0);
      const head = rest.slice(0, end);
      const fence = openFence(this.current + head);
      out[out.length - 1] += head + (fence ? CLOSE_FENCE : '');
      rest = rest.slice(next).replace(/^\n+/, '');
      this.current = fence ? `${fence}\n` : '';
      out.push(this.current);
      fresh = true;
    }
    out[out.length - 1] += rest;
    this.current += rest;
    return out;
  }
}

/**
 * Where to cut a delta that has `room` characters left in the message. With
 * no break inside the room, the whole delta moves to the next message
 * (`canDefer`), so a word that arrived in one chunk isn't cut in half.
 */
function cutDelta(
  delta: string,
  room: number,
  canDefer: boolean
): { end: number; next: number } {
  const window = delta.slice(0, Math.max(room, 0) + 1);
  for (const sep of ['\n', ' ']) {
    const at = window.lastIndexOf(sep);
    if (at > 0 && at <= room) return { end: at, next: at + sep.length };
  }
  if (canDefer || room <= 0) return { end: 0, next: 0 };
  const code = delta.charCodeAt(room - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? room - 1 : room;
  return { end, next: end };
}

/** Posts and edits messages on a chat platform. */
export interface MessageSink<M> {
  post(text: string): Promise<M>;
  edit(message: M, text: string): Promise<void>;
}

/**
 * Renders a growing reply as one or more messages: call `render` with the
 * whole text so far (while streaming, and once at the end). It edits the
 * messages already posted and posts new ones as the reply passes `maxLen`.
 */
export interface MessageRenderer {
  render(text: string): Promise<void>;
  /** How many messages have been posted. */
  readonly posted: number;
}

export function messageRenderer<M>(
  sink: MessageSink<M>,
  maxLen: number
): MessageRenderer {
  const sent: Array<{ message: M; text: string }> = [];
  return {
    get posted() {
      return sent.length;
    },
    async render(text) {
      const parts = splitMessage(text, maxLen);
      for (const [i, part] of parts.entries()) {
        const prev = sent[i];
        if (!prev) {
          sent.push({ message: await sink.post(part), text: part });
        } else if (prev.text !== part) {
          await sink.edit(prev.message, part);
          prev.text = part;
        }
      }
    },
  };
}
