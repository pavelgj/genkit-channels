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
 * Runs one agent turn and streams it into a {@link Reply}. Knows nothing about
 * Slack, so tests drive it with a real (echo) agent and a recording reply.
 */

import {
  type ActionContext,
  type AgentAPI,
  type AgentHandleOptions,
  type AgentResponse,
} from 'genkit-channels';
import { describeFailure } from 'genkit-channels/chat';

/** Where a turn's output goes (a Slack thread, in production). */
export interface Reply {
  /** Show a "thinking" indicator until the first text lands. Best-effort. */
  thinking(): Promise<void>;
  /** Append streamed text. */
  append(text: string): Promise<void>;
  /** Finish the message. `fullText` is the whole reply. */
  finish(fullText: string): Promise<void>;
  /** The turn failed; tell the user. */
  fail(message: string): Promise<void>;
}

/** Client-managed agents: the conversation state the channel carries. */
export type AgentState = AgentResponse['raw']['state'];

export async function runTurn(opts: {
  /** The agent handle for this conversation, given the caller's context. */
  agent: (opts: AgentHandleOptions) => AgentAPI;
  /**
   * Who is asking, as action context (`channel.context(...)`). Resolved before
   * anything is posted, so a refused caller gets one short message.
   */
  context: () => Promise<ActionContext>;
  agentState: 'server' | 'client';
  sessionId: string;
  input: string;
  reply: Reply;
  /** Client-managed agents: what the previous turn returned as `state`. */
  state?: AgentState;
  /** Stops the turn (another drainer took this thread over). */
  signal?: AbortSignal;
  log?: (msg: string) => void;
}): Promise<AgentResponse | undefined> {
  const { agentState, sessionId, input, reply } = opts;
  let context: ActionContext;
  try {
    context = await opts.context();
  } catch (e) {
    // Usually the provider refusing the caller; anything else (the app is
    // down, say) is classified the same way as a failed turn.
    const failure = describeFailure(e);
    opts.log?.(`no context: ${failure.logMessage}`);
    await reply.fail(failure.userMessage).catch(() => {});
    return undefined;
  }
  // One handle per conversation, so `box.route: session` gives each thread
  // its own box.
  const agent = opts.agent({ sessionId, context });
  const chat =
    agentState === 'client'
      ? agent.chat({ state: opts.state })
      : agent.chat({ sessionId });

  await reply.thinking().catch(() => {});
  let streamed = '';
  try {
    const turn = chat.sendStream(input, { abortSignal: opts.signal });
    for await (const chunk of turn.stream) {
      if (chunk.text) {
        streamed += chunk.text;
        await reply.append(chunk.text);
      }
    }
    const res = await turn.response;
    await reply.finish(res.text || streamed);
    // Client-managed agents: the caller saves `res.raw.state` for next time.
    return res;
  } catch (e) {
    // Cut short on purpose: whoever drains next answers, so say nothing.
    if (opts.signal?.aborted) {
      opts.log?.('turn stopped: the thread moved to another drainer');
      return undefined;
    }
    // What streamed stays; the reply adds the failure note after it.
    const failure = describeFailure(e);
    opts.log?.(`turn failed: ${failure.logMessage}`);
    await reply.fail(failure.userMessage).catch(() => {});
    return undefined;
  }
}
