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
 * Discord (gateway) channel entry point, written in TypeScript.
 *
 * Runs one of the user's Genkit agents as a Discord bot. The bot holds an
 * outbound WebSocket to Discord (via discord.js), so there is no public HTTP
 * endpoint; a tiny health server on $PORT exists only so the platform sees the
 * container listen.
 *
 * There is no codegen and no import of user code. `initChannel()` reads the
 * deployment config and hands back an agent proxy; the app itself runs in a
 * box (subprocess, sandbox, container, ...) that starts on first use, so the
 * same channel works against a JS, Go, or Python app.
 *
 * As a TypeScript channel it declares a `build` in its `channel.yaml` that
 * compiles `src/*.ts` to `dist/*.js` (the `entry`); the CLI runs it at install
 * time (after confirmation) and again at image build.
 */

import {
  type AnyThreadChannel,
  ChannelType,
  Client,
  GatewayIntentBits,
  type Message,
  Partials,
  type SendableChannels,
  type TextBasedChannel,
} from 'discord.js';
import {
  initChannel,
  type ActionContext,
  type AgentChat,
  type AgentResponse,
} from 'genkit-channels';
import {
  createConversations,
  describeFailure,
  filterAllowed,
  messageRenderer,
  sessionId,
  type AllowedBatch,
  type TurnInput,
} from 'genkit-channels/chat';
import { createServer } from 'node:http';
import {
  MAX_DISCORD_LEN,
  deriveSessionKey,
  formatGatheredMessages,
  stripMention,
  turnMessages,
  type IdentifiedMessage,
} from './bridge.js';

/** How long a single stream edit waits before the next (rate-limit friendly). */
const DEFAULT_STREAM_EDIT_MS = 700;
/** Max messages to scan when gathering the batch since the last bot reply. */
const GATHER_FETCH_LIMIT = 50;

/**
 * A triggering message as queued: plain data, so a persistent store can hold
 * it. The handler fetches the live channel again from `channelId`.
 */
interface QueuedMessage {
  id: string;
  channelId: string;
  guildId?: string;
  author: { id: string; username: string };
  /** The text with the bot's mention removed. */
  text: string;
}

/** What a conversation keeps between turns. */
interface ConversationState {
  /** Client-managed agents: the agent's state after the last turn. */
  agent?: AgentResponse['raw']['state'];
  /**
   * The newest message id a turn has used, so the next turn's history
   * gather doesn't repeat it.
   */
  answeredUpTo?: string;
}

/** Discord-specific options (the deployment's `with` block). */
interface DiscordOptions {
  streamEditIntervalMs?: number;
  session?: 'thread' | 'channel';
  includeSenderName?: boolean;
  /**
   * Messages that arrive in a conversation while a turn is running go into
   * the next turn together (true, default), or each get their own turn
   * (false).
   */
  coalesce?: boolean;
}

async function main(): Promise<void> {
  // Reads the deployment config and checks the secrets declared in
  // channel.yaml. Sync: the app's box starts on the first turn (or at startup
  // with `box.warm: true`).
  const app = initChannel<DiscordOptions>();
  const token = app.secret('DISCORD_TOKEN');
  const { options } = app;

  // The bot drives exactly one agent: `expose.agent` in channels.yaml.
  if (app.expose.agents.length !== 1) {
    console.error(
      '[channel:discord] expose exactly one agent (`expose.agent` in ' +
        `channels.yaml); got: ${app.expose.agents.join(', ') || '(none)'}`
    );
    process.exit(1);
  }
  const agentName = app.expose.agents[0];
  const agentState = app.agentState(agentName);

  // Ready once the gateway login completes. The app is not part of readiness:
  // a boxed app may legitimately not be running until the first message.
  let ready = false;
  let botId: string | undefined;

  // Health / readiness endpoint on $PORT. 200 once ready, 503 while starting up.
  const port = Number(process.env.PORT) || 8080;
  const health = createServer((req, res) => {
    if (!ready) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'starting' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({ status: 'ok', agent: agentName, platform: 'discord' })
    );
  });
  health.listen(port, () => {
    console.log(
      `[channel:discord] health on :${port} (connecting to Discord)`
    );
  });

  const streamEditIntervalMs =
    options.streamEditIntervalMs ?? DEFAULT_STREAM_EDIT_MS;
  const sessionScope = options.session ?? 'thread';
  const includeSenderName =
    options.includeSenderName ?? sessionScope === 'channel';
  const coalesce = options.coalesce ?? true;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  // One turn at a time per conversation, with the state the previous turn
  // saved; different conversations run in parallel. Queued messages are the
  // triggers (DMs and mentions).
  const conversations = createConversations<QueuedMessage, ConversationState>({
    coalesce,
    handler: runBatch,
    onError: (key, e) =>
      console.error(`[channel:discord] turn for ${key} failed:`, e),
  });

  client.on('messageCreate', (msg) => {
    if (msg.author.bot) return;
    const isDM = msg.channel.type === ChannelType.DM;
    const mentionsBot = !!botId && msg.mentions.users.has(botId);
    // Only respond in DMs or when mentioned in a channel.
    if (!isDM && !mentionsBot) return;
    void conversations.post(conversationKey(msg, isDM), {
      id: msg.id,
      payload: {
        id: msg.id,
        channelId: msg.channelId,
        ...(msg.guildId ? { guildId: msg.guildId } : {}),
        author: { id: msg.author.id, username: msg.author.username },
        text: stripMention(msg.content, botId),
      },
    });
  });

  /** The conversation a message belongs to (see `deriveSessionKey`). */
  function conversationKey(msg: Message, isDM: boolean): string {
    const isThread =
      msg.channel.type === ChannelType.PublicThread ||
      msg.channel.type === ChannelType.PrivateThread;
    const channelId = isThread
      ? (msg.channel as AnyThreadChannel).parentId ?? msg.channelId
      : msg.channelId;
    return deriveSessionKey({
      isDM,
      userId: msg.author.id,
      channelId,
      threadId: isThread ? msg.channelId : undefined,
      id: msg.id,
    });
  }

  /**
   * Runs one turn for the triggers queued in a conversation: checks each
   * author, gathers what was posted since the bot's last reply (so a burst
   * of messages between mentions becomes one turn), and streams the reply.
   */
  async function runBatch({
    key,
    messages: queued,
    state,
    signal,
  }: TurnInput<QueuedMessage, ConversationState>): Promise<{
    state: ConversationState;
  } | void> {
    const first = queued[0].payload;
    const channel = await client.channels.fetch(first.channelId);
    if (!channel?.isTextBased() || !channel.isSendable()) {
      console.error(`[channel:discord] can't reply in channel ${first.channelId}`);
      return;
    }
    const replyTo = (id: string, content: string) =>
      channel.send({ content, reply: { messageReference: id } }).catch(() => {});

    // `{}` unless the deployment sets `expose.contextProvider`. A coalesced
    // batch runs as one caller, so each author is checked; a refused author
    // gets one short reply and their messages never reach the agent.
    let checked: AllowedBatch<QueuedMessage>;
    try {
      checked = await filterAllowed(
        queued.map((m) => m.payload),
        (m) => m.author.id,
        (m) =>
          app.context({
            input: m.text,
            channel: {
              platform: 'discord',
              user: { id: m.author.id, displayName: m.author.username },
              ...(m.guildId ? { tenant: m.guildId } : {}),
            },
          })
      );
    } catch (e) {
      const failure = describeFailure(e);
      console.error(`[channel:discord] no context: ${failure.logMessage}`);
      await replyTo(first.id, failure.userMessage);
      return;
    }
    for (const { author, error } of checked.refused) {
      const failure = describeFailure(error);
      console.log(`[channel:discord] refused ${author}: ${failure.logMessage}`);
      const theirs = queued.filter((m) => m.payload.author.id === author);
      const lastOfTheirs = theirs[theirs.length - 1];
      if (lastOfTheirs) await replyTo(lastOfTheirs.id, failure.userMessage);
    }
    const allowed = checked.messages;
    const last = allowed[allowed.length - 1];
    if (!last || checked.context === undefined) return;
    const refusedIds = new Set(
      queued
        .filter((m) => checked.refused.some((r) => r.author === m.payload.author.id))
        .map((m) => m.id)
    );

    const triggers = allowed.map((m) => ({
      id: m.id,
      userName: m.author.username,
      text: m.text,
    }));
    // History is context the triggering user chose to bring in by mentioning
    // the bot; it still never includes a refused author's queued triggers.
    const history = (await gatherSince(channel, last.id)).filter(
      (m) => !refusedIds.has(m.id)
    );
    const messages = turnMessages(triggers, history, state?.answeredUpTo);
    const input = formatGatheredMessages(messages, { includeSenderName });
    if (!input) return;
    const answeredUpTo = messages[messages.length - 1]?.id ?? last.id;

    const res = await runTurn({
      sessionKey: key,
      channel,
      input,
      context: checked.context,
      agentState: state?.agent,
      signal,
    });
    // Saved with the messages marked handled. Server-managed agents keep
    // their history in their own store; client-managed ones carry it here.
    return {
      state: {
        answeredUpTo,
        agent: agentState === 'client' ? (res?.raw.state ?? state?.agent) : undefined,
      },
    };
  }

  function asGathered(m: Message): IdentifiedMessage {
    return {
      userName: m.author.username,
      text: stripMention(m.content, botId),
      id: m.id,
    };
  }

  /**
   * Non-bot messages in the channel posted before `beforeId` and after the
   * bot's last message, oldest first. This turns "several messages posted
   * between mentions" into a single agent input.
   */
  async function gatherSince(
    channel: TextBasedChannel,
    beforeId: string
  ): Promise<IdentifiedMessage[]> {
    try {
      const recent = await channel.messages.fetch({
        limit: GATHER_FETCH_LIMIT,
        before: beforeId,
      });
      // `fetch` returns newest-first; stop at the bot's last message.
      const older: IdentifiedMessage[] = [];
      for (const m of recent.values()) {
        if (m.author.bot) break;
        older.push(asGathered(m));
      }
      return older.reverse();
    } catch {
      // History isn't available (permissions, DM quirks): the triggers alone.
      return [];
    }
  }

  /** Opens a chat honoring server- vs client-managed state, runs, and streams. */
  async function runTurn({
    sessionKey,
    channel,
    input,
    context,
    agentState: previous,
    signal,
  }: {
    sessionKey: string;
    channel: SendableChannels;
    input: string;
    context: ActionContext;
    /** Client-managed agents: the state the previous turn returned. */
    agentState?: AgentResponse['raw']['state'];
    signal: AbortSignal;
  }): Promise<AgentResponse | undefined> {
    const id = sessionId(sessionKey);
    // One handle per conversation: with `box.route: session` every call of
    // this conversation goes to its own box. Handles are cheap.
    const agent = app.agent(agentName, { sessionId: id, context });
    const chat: AgentChat =
      agentState === 'client'
        ? agent.chat({ state: previous })
        : agent.chat({ sessionId: id });
    return streamReply(chat, input, channel, signal);
  }

  /**
   * Streams an agent turn to Discord as debounced edits. A reply longer than
   * Discord's limit continues in further messages instead of being cut off.
   */
  async function streamReply(
    chat: AgentChat,
    input: string,
    sendable: SendableChannels,
    signal: AbortSignal
  ): Promise<AgentResponse | undefined> {
    const out = messageRenderer<Message>(
      {
        post: (text) => sendable.send(text),
        edit: async (message, text) => {
          await message.edit(text);
        },
      },
      MAX_DISCORD_LEN
    );
    let accumulated = '';
    let lastEdit = 0;

    const flush = async (force = false): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastEdit < streamEditIntervalMs) return;
      if (!accumulated.trim()) return;
      lastEdit = now;
      await out.render(accumulated);
    };

    const turn = chat.sendStream(input, { abortSignal: signal });
    try {
      // Typing indicator until the first content lands.
      sendable.sendTyping().catch(() => {});
      for await (const chunk of turn.stream) {
        if (chunk.text) {
          accumulated += chunk.text;
          await flush();
        }
      }
      const res = await turn.response;
      accumulated = res.text || accumulated;
      await flush(true);
      return res;
    } catch (e) {
      // Cut short on purpose: whoever drains next answers, so say nothing.
      if (signal.aborted) return undefined;
      // What streamed stays; the failure note goes after it.
      const failure = describeFailure(e);
      console.error(`[channel:discord] turn failed: ${failure.logMessage}`);
      await flush(true).catch(() => {});
      await sendable.send(failure.userMessage).catch(() => {});
      return undefined;
    } finally {
      // Settles the response promise when the stream threw first.
      await turn.response.catch(() => {});
    }
  }

  // Log in to Discord. No need to wait for the app: its box starts on the
  // first turn.
  console.log(
    `[channel:discord] driving agent "${agentName}" (${agentState} state)`
  );
  try {
    await new Promise<void>((resolve, reject) => {
      client.once('clientReady', () => {
        botId = client.user?.id;
        resolve();
      });
      client.login(token).catch(reject);
    });

    ready = true;
    console.log(
      `[channel:discord] ready as ${client.user?.tag} (bot id ${botId})`
    );
  } catch (e) {
    console.error(`[channel:discord] ${(e as Error).message}`);
    await app.close();
    process.exit(1);
  }

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`[channel:discord] ${signal} received, shutting down`);
    health.close();
    // Let turns in progress finish (or cut them after 10s) while the
    // gateway connection can still post their replies.
    await conversations.close();
    try {
      await client.destroy();
    } catch {
      // ignore
    }
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('[channel:discord] fatal', e);
  process.exit(1);
});
