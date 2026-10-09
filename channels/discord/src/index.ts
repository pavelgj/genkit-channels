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
} from 'discord.js';
import { initChannel, type AgentChat, type AgentResponse } from 'genkit-channels';
import { createServer } from 'node:http';
import {
  deriveSessionKey,
  formatGatheredMessages,
  stripMention,
  truncate,
  uuidv5,
} from './bridge.js';

/** How long a single stream edit waits before the next (rate-limit friendly). */
const DEFAULT_STREAM_EDIT_MS = 700;
/** Max messages to scan when gathering the batch since the last bot reply. */
const GATHER_FETCH_LIMIT = 50;

/** Discord-specific options (the deployment's `with` block). */
interface DiscordOptions {
  streamEditIntervalMs?: number;
  session?: 'thread' | 'channel';
  includeSenderName?: boolean;
}

async function main(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error('[channel:discord] DISCORD_TOKEN is not set');
    process.exit(1);
  }

  // Reads the deployment config. Sync: the app's box starts on the first turn
  // (or at startup with `box.warm: true`).
  const channel = initChannel<DiscordOptions>();
  const { options } = channel;

  // The bot drives exactly one agent: `expose.agent` in channels.yaml.
  if (channel.expose.agents.length !== 1) {
    console.error(
      '[channel:discord] expose exactly one agent (`expose.agent` in ' +
        `channels.yaml); got: ${channel.expose.agents.join(', ') || '(none)'}`
    );
    process.exit(1);
  }
  const agentName = channel.expose.agents[0];
  const agent = channel.agent(agentName);
  const agentState = channel.agentState(agentName);

  // Ready once the gateway login completes. The app is not part of readiness:
  // a boxed app may legitimately not be running until the first message.
  let ready = false;
  let botId: string | undefined;

  // Client-managed agents (no server store): keep the latest state per session
  // key so the next turn can round-trip it. Server-managed agents ignore this
  // (their store remembers the conversation by sessionId).
  const clientState = new Map<string, AgentResponse['raw']['state']>();

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

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  client.on('messageCreate', async (msg) => {
    try {
      if (msg.author.bot) return;
      const isDM = msg.channel.type === ChannelType.DM;
      const mentionsBot = !!botId && msg.mentions.users.has(botId);
      // Only respond in DMs or when mentioned in a channel.
      if (!isDM && !mentionsBot) return;

      await handleTrigger(msg, isDM);
    } catch (e) {
      console.error('[channel:discord] error handling message:', e);
      try {
        await msg.reply(
          'Sorry, something went wrong handling that. Please try again.'
        );
      } catch {
        // best-effort
      }
    }
  });

  /**
   * Handles a triggering message: gathers the messages posted since the bot's
   * last reply (so a burst of messages between mentions becomes one turn),
   * runs an agent turn, and streams the reply back.
   */
  async function handleTrigger(msg: Message, isDM: boolean): Promise<void> {
    const isThread =
      msg.channel.type === ChannelType.PublicThread ||
      msg.channel.type === ChannelType.PrivateThread;
    const channelId = isThread
      ? (msg.channel as AnyThreadChannel).parentId ?? msg.channelId
      : msg.channelId;
    const threadId = isThread ? msg.channelId : undefined;

    const sessionKey = deriveSessionKey({
      isDM,
      userId: msg.author.id,
      channelId,
      threadId,
      id: msg.id,
    });
    const sessionId = uuidv5(sessionKey);

    const gathered = await gatherSince(msg);
    const input = formatGatheredMessages(gathered, { includeSenderName });
    if (!input) return;

    await runTurn({ sessionKey, sessionId, channel: msg.channel, input });
  }

  /**
   * Gathers non-bot messages in the triggering message's channel since the
   * bot's last message, oldest first, always including the trigger. This turns
   * "several messages posted between mentions" into a single agent input.
   */
  async function gatherSince(
    trigger: Message
  ): Promise<Array<{ userName: string; text: string; id: string }>> {
    const collected = [
      {
        userName: trigger.author.username,
        text: stripMention(trigger.content, botId),
        id: trigger.id,
      },
    ];
    try {
      const recent = await trigger.channel.messages.fetch({
        limit: GATHER_FETCH_LIMIT,
        before: trigger.id,
      });
      // `fetch` returns newest-first; walk newest -> oldest and stop at the
      // bot's last message (exclusive) or the first bot boundary.
      const older: Array<{ userName: string; text: string; id: string }> = [];
      for (const m of recent.values()) {
        if (m.author.bot) break;
        older.push({
          userName: m.author.username,
          text: stripMention(m.content, botId),
          id: m.id,
        });
      }
      // `older` is newest-first; prepend reversed so the batch is oldest-first.
      older.reverse();
      return [...older, ...collected];
    } catch {
      // If history isn't available (permissions, DM quirks), just use the trigger.
      return collected;
    }
  }

  /** Opens a chat honoring server- vs client-managed state, runs, and streams. */
  async function runTurn({
    sessionKey,
    sessionId,
    channel,
    input,
  }: {
    sessionKey: string;
    sessionId: string;
    channel: Message['channel'];
    input: string;
  }): Promise<void> {
    const chat: AgentChat =
      agentState === 'client'
        ? agent.chat({ state: clientState.get(sessionKey) })
        : agent.chat({ sessionId });

    const res = await streamReply(chat, input, channel);

    // Persist client-managed state for the next turn.
    const state = res?.raw.state;
    if (agentState === 'client' && state !== undefined) {
      clientState.set(sessionKey, state);
    }
  }

  /**
   * Streams an agent turn to Discord as progressive edits of a single message,
   * debounced and truncated to Discord's limit. Falls back to a final post.
   */
  async function streamReply(
    chat: AgentChat,
    input: string,
    channel: Message['channel']
  ): Promise<AgentResponse | undefined> {
    const turn = chat.sendStream(input);
    let sent: Message | undefined;
    let accumulated = '';
    let lastEdit = 0;
    let lastRendered = '';

    if (!channel.isSendable()) return undefined;
    const sendable: SendableChannels = channel;

    const flush = async (force = false): Promise<void> => {
      const now = Date.now();
      if (!force && now - lastEdit < streamEditIntervalMs) return;
      const text = truncate(accumulated.trim());
      if (!text || text === lastRendered) return;
      lastEdit = now;
      lastRendered = text;
      if (!sent) {
        sent = await sendable.send(text);
      } else {
        await sent.edit(text);
      }
    };

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
      const finalText = truncate((res.text || accumulated).trim());
      if (finalText) {
        if (!sent) {
          await sendable.send(finalText);
        } else if (finalText !== lastRendered) {
          await sent.edit(finalText);
        }
      }
      return res;
    } catch (e) {
      console.error('[channel:discord] turn failed:', (e as Error).message);
      const note = 'Sorry, something went wrong. Please try again.';
      if (!sent) await sendable.send(note).catch(() => {});
      return undefined;
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
    await channel.close();
    process.exit(1);
  }

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`[channel:discord] ${signal} received, shutting down`);
    health.close();
    try {
      await client.destroy();
    } catch {
      // ignore
    }
    await channel.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('[channel:discord] fatal', e);
  process.exit(1);
});
