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
  isAuthError,
  type ActionContext,
  type AgentAPI,
  type AgentHandleOptions,
  type AgentResponse,
} from 'genkit-channels';

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

/** Client-managed agents: conversation state the channel carries per thread. */
export type ClientStateStore = Map<string, AgentResponse['raw']['state']>;

export const FAILURE_MESSAGE = 'Sorry, something went wrong. Please try again.';
export const REFUSED_MESSAGE = "Sorry, you aren't allowed to use this bot.";

export async function runTurn(opts: {
  /** The agent handle for this conversation, given the caller's context. */
  agent: (opts: AgentHandleOptions) => AgentAPI;
  /**
   * Who is asking, as action context (`channel.context(...)`). Resolved before
   * anything is posted, so a refused caller gets one short message.
   */
  context: () => Promise<ActionContext>;
  agentState: 'server' | 'client';
  sessionKey: string;
  sessionId: string;
  input: string;
  reply: Reply;
  clientState: ClientStateStore;
  log?: (msg: string) => void;
}): Promise<AgentResponse | undefined> {
  const { agentState, sessionKey, sessionId, input, reply, clientState } = opts;
  let context: ActionContext;
  try {
    context = await opts.context();
  } catch (e) {
    opts.log?.(`caller refused: ${(e as Error).message}`);
    await reply.fail(isAuthError(e) ? REFUSED_MESSAGE : FAILURE_MESSAGE).catch(() => {});
    return undefined;
  }
  // One handle per conversation, so `box.route: session` gives each thread
  // its own box.
  const agent = opts.agent({ sessionId, context });
  const chat =
    agentState === 'client'
      ? agent.chat({ state: clientState.get(sessionKey) })
      : agent.chat({ sessionId });

  await reply.thinking().catch(() => {});
  let streamed = '';
  try {
    const turn = chat.sendStream(input);
    for await (const chunk of turn.stream) {
      if (chunk.text) {
        streamed += chunk.text;
        await reply.append(chunk.text);
      }
    }
    const res = await turn.response;
    await reply.finish(res.text || streamed);
    if (agentState === 'client' && res.raw.state !== undefined) {
      clientState.set(sessionKey, res.raw.state);
    }
    return res;
  } catch (e) {
    opts.log?.(`turn failed: ${(e as Error).message}`);
    await reply.fail(FAILURE_MESSAGE).catch(() => {});
    return undefined;
  }
}
