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
 * Slack (Socket Mode) channel: runs one Genkit agent as a Slack bot.
 *
 * Socket Mode keeps an outbound WebSocket to Slack (via Bolt), so there is no
 * public endpoint; the health server on $PORT only lets the platform see the
 * container listen.
 *
 * The bot answers @mentions (in a thread under the message), DMs, and, with
 * `followThreads`, later replies in threads it has answered in. Each Slack
 * thread is one conversation and one agent session.
 */

import { App, LogLevel } from '@slack/bolt';
import { initChannel } from 'genkit-channels';
import {
  createConversations,
  describeFailure,
  filterAllowed,
  sessionId,
  type AllowedBatch,
  type ConversationMessage,
  type TurnInput,
} from 'genkit-channels/chat';
import { createServer } from 'node:http';
import {
  type BotIdentity,
  type FetchThread,
  type IncomingEvent,
  type ThreadMessage,
  ThreadTracker,
  type Trigger,
  mentionTrigger,
  messageTrigger,
  missedMessages,
  sessionKey,
} from './bridge.js';
import { editReply, nativeStreamReply, type ReplyTarget } from './slack-reply.js';
import { type AgentState, runTurn } from './turn.js';

/** Slack-specific options (the deployment's `with` block). */
interface SlackOptions {
  /** Keep answering in a thread once the bot has replied there. Default true. */
  followThreads?: boolean;
  /** `native` (Slack text streaming, default) or `edit` (debounced updates). */
  stream?: 'native' | 'edit';
  /** Debounce for `stream: edit`. Default 700ms. */
  streamEditIntervalMs?: number;
  /**
   * Messages that arrive in a thread while a turn is running go into the next
   * turn together (true), or each get their own turn, in order (false,
   * default).
   */
  coalesce?: boolean;
}

/** One triggering Slack event, as queued in a thread's conversation. */
interface ThreadEvent {
  ev: IncomingEvent;
  trigger: Trigger;
  team: string;
}

/** What a thread's conversation keeps between turns. */
interface ThreadState {
  /** Client-managed agents: the agent's state after the last turn. */
  agent?: AgentState;
}

const log = (msg: string) => console.log(`[channel:slack] ${msg}`);

/** Bot scopes the channel uses (see manifest.json). */
const REQUIRED_SCOPES = [
  'app_mentions:read',
  'chat:write',
  'im:history',
  'channels:history',
  'groups:history',
];

async function main(): Promise<void> {
  const channel = initChannel<SlackOptions>();
  const { options } = channel;
  if (channel.expose.agents.length !== 1) {
    console.error(
      '[channel:slack] expose exactly one agent (`expose.agent` in ' +
        `channels.yaml); got: ${channel.expose.agents.join(', ') || '(none)'}`
    );
    process.exit(1);
  }
  const agentName = channel.expose.agents[0];
  const agentState = channel.agentState(agentName);
  const followThreads = options.followThreads ?? true;
  const streamMode = options.stream ?? 'native';
  const editIntervalMs = options.streamEditIntervalMs ?? 700;
  const coalesce = options.coalesce ?? false;

  const app = new App({
    token: channel.secret('SLACK_BOT_TOKEN'),
    appToken: channel.secret('SLACK_APP_TOKEN'),
    socketMode: true,
    // SLACK_DEBUG=1 also turns on Bolt's own (very chatty) socket logging.
    logLevel: process.env.SLACK_DEBUG ? LogLevel.DEBUG : LogLevel.WARN,
  });

  // SLACK_DEBUG=1: log every payload Slack delivers, before any filtering.
  // The quickest way to tell "Slack sends nothing" (app config) from "we
  // ignore it" (trigger rules).
  if (process.env.SLACK_DEBUG) {
    app.use(async ({ body, next }) => {
      log(`raw: ${JSON.stringify(body).slice(0, 600)}`);
      await next();
    });
  }

  let team = '';
  const bot: BotIdentity = {};

  /**
   * Reads a thread, oldest first. One call covers threads up to Slack's
   * default page size (1000 messages); longer ones are judged by that page.
   * Failures (rate limits included) log and return undefined, so callers fall
   * back to "not followed" instead of failing the event.
   */
  const fetchThread: FetchThread = async (channelId, threadTs) => {
    try {
      const res = await app.client.conversations.replies({ channel: channelId, ts: threadTs });
      return (res.messages ?? []).flatMap((m): ThreadMessage[] =>
        m.ts
          ? [
              {
                ts: m.ts,
                user: m.user,
                botId: m.bot_id,
                // Present on the wire, missing from the SDK's response type.
                subtype: 'subtype' in m && typeof m.subtype === 'string' ? m.subtype : undefined,
                text: m.text,
              },
            ]
          : []
      );
    } catch (e) {
      log(`could not read thread ${threadTs} in ${channelId}: ${(e as Error).message}`);
      return undefined;
    }
  };

  // Threads the bot takes part in, for `followThreads`. Unknown threads are
  // checked against Slack once, so following survives restarts.
  const threads = new ThreadTracker({ fetchThread, bot: () => bot });

  /**
   * The turn input for a batch from one thread. A bare mention (catch-up)
   * reads the thread, which already holds every message in the batch;
   * otherwise it's the messages' text, one per line, like catch-up input.
   */
  async function batchInput(
    batch: ConversationMessage<ThreadEvent>[],
    notify: (text: string) => Promise<unknown>
  ): Promise<string | undefined> {
    const last = batch[batch.length - 1].payload;
    const bare = [...batch].reverse().find((m) => m.payload.trigger.catchUp)?.payload;
    if (!bare) return batch.map((m) => m.payload.trigger.text).join('\n');
    const thread = await fetchThread(last.ev.channel, last.trigger.threadTs);
    if (!thread) {
      await notify("I couldn't read this thread. Mention me again with your message.");
      return undefined;
    }
    const input = missedMessages(thread, bot, bare.ev.ts);
    if (!input) {
      await notify("I'm here. Nothing new since my last reply, so go ahead and ask.");
      return undefined;
    }
    log(`catching up in thread ${last.trigger.threadTs}`);
    return input;
  }

  /** The context provider's view of one Slack event's author. */
  const contextFor = (e: ThreadEvent, input: string) =>
    channel.context({
      input,
      channel: {
        platform: 'slack',
        ...(e.ev.user ? { user: { id: e.ev.user } } : {}),
        ...(e.team ? { tenant: e.team } : {}),
      },
    });

  /** Runs one turn for a batch of events from the same thread. */
  async function runBatch({
    key,
    messages: queued,
    state,
    signal,
  }: TurnInput<ThreadEvent, ThreadState>): Promise<{ state: ThreadState } | void> {
    const first = queued[0].payload;
    const say = (text: string) =>
      app.client.chat
        .postMessage({ channel: first.ev.channel, thread_ts: first.trigger.threadTs, text })
        .catch((e: Error) => log(`could not post to thread ${first.trigger.threadTs}: ${e.message}`));
    // A coalesced batch runs as one caller, so each author is checked, and
    // refused authors' messages never reach the agent.
    let checked: AllowedBatch<ConversationMessage<ThreadEvent>>;
    try {
      checked = await filterAllowed(
        queued,
        (m) => m.payload.ev.user ?? '',
        (m) => contextFor(m.payload, m.payload.trigger.text)
      );
    } catch (e) {
      const failure = describeFailure(e);
      log(`no context: ${failure.logMessage}`);
      await say(failure.userMessage);
      return;
    }
    for (const { author, error } of checked.refused) {
      log(`refused ${author || '(unknown user)'}: ${describeFailure(error).logMessage}`);
    }
    const batch = checked.messages;
    if (batch.length === 0 || checked.context === undefined) {
      await say(describeFailure(checked.refused[0]?.error).userMessage);
      return;
    }
    const context = checked.context;
    // The reply goes to whoever posted last.
    const { ev, trigger, team: teamId } = batch[batch.length - 1].payload;
    const target: ReplyTarget = {
      channel: ev.channel,
      threadTs: trigger.threadTs,
      user: ev.user,
      team: teamId,
    };
    const input = await batchInput(batch, say);
    if (!input) return;
    const started = Date.now();
    log(
      `turn start: thread ${trigger.threadTs}` +
        (batch.length > 1 ? ` (${batch.length} messages)` : '')
    );
    const res = await runTurn({
      agent: (handle) => channel.agent(agentName, handle),
      // Checked above (`{}` without `expose.contextProvider`).
      context: async () => context,
      agentState,
      sessionId: sessionId(key),
      input,
      reply:
        streamMode === 'edit'
          ? editReply(app.client, target, editIntervalMs)
          : nativeStreamReply(app.client, target),
      state: state?.agent,
      signal,
      log,
    });
    log(
      `turn ${res ? 'done' : 'failed'}: thread ${trigger.threadTs} ` +
        `(${Date.now() - started}ms)`
    );
    // Saved with the messages marked handled. Server-managed agents keep
    // their history in their own store, so there's nothing to save.
    if (agentState === 'client' && res?.raw.state !== undefined) {
      return { state: { agent: res.raw.state } };
    }
  }

  // One turn at a time per thread, in order; different threads run in
  // parallel. Catch-up reads the thread inside the turn, so it sees replies
  // to earlier turns.
  const conversations = createConversations<ThreadEvent, ThreadState>({
    coalesce,
    handler: runBatch,
    onError: (key, e) => log(`turn for ${key} failed: ${e instanceof Error ? e.message : String(e)}`),
  });

  function handle(ev: IncomingEvent, trigger: Trigger, eventTeam?: string): Promise<void> {
    const teamId = eventTeam || team;
    threads.follow(ev.channel, trigger.threadTs);
    // Slack retries events it thinks weren't acked; the channel and ts
    // identify a message, so a retry is dropped.
    return conversations.post(sessionKey(teamId, ev.channel, trigger.threadTs), {
      id: `${ev.channel}:${ev.ts}`,
      payload: { ev, trigger, team: teamId },
    });
  }

  // Listeners return right away: Bolt acks on return, and Slack redelivers
  // events that aren't acked within 3s. Turns run in the background.
  app.event('app_mention', async ({ event, context }) => {
    const ev: IncomingEvent = {
      channel: event.channel,
      user: event.user,
      botId: event.bot_id,
      subtype: event.subtype,
      text: event.text,
      ts: event.ts,
      threadTs: event.thread_ts,
    };
    const trigger = mentionTrigger(ev, context.botUserId ?? bot.userId);
    log(
      `app_mention in ${ev.channel} from ${ev.user ?? '?'}` +
        (trigger ? (trigger.catchUp ? ' (bare, catching up)' : '') : ' (ignored)')
    );
    if (trigger) void handle(ev, trigger, context.teamId);
  });

  app.message(async ({ message, context }) => {
    // Only plain user messages (no subtype) carry text and a user.
    if (message.subtype !== undefined) return;
    const ev: IncomingEvent = {
      channel: message.channel,
      channelType: message.channel_type,
      user: message.user,
      botId: message.bot_id,
      text: message.text,
      ts: message.ts,
      threadTs: message.thread_ts,
    };
    // Deciding may read the thread from Slack (unknown thread after a
    // restart), so it runs in the background too, not before the ack.
    void (async () => {
      const trigger = await messageTrigger(ev, {
        botUserId: context.botUserId ?? bot.userId,
        followThreads,
        isFollowed: (threadTs) => threads.isFollowed(ev.channel, threadTs),
      });
      // Channel chatter is the common case; only log what we act on, and DMs.
      if (trigger || ev.channelType === 'im') {
        log(
          `message (${ev.channelType}) in ${ev.channel} from ${ev.user ?? '?'}` +
            (trigger ? '' : ' (ignored)')
        );
      }
      if (trigger) await handle(ev, trigger, context.teamId);
    })().catch((e: Error) => log(`message handling failed: ${e.message}`));
  });

  app.error(async (error) => {
    console.error('[channel:slack] error:', error.message);
  });

  let ready = false;
  const port = Number(process.env.PORT) || 8080;
  const health = createServer((_req, res) => {
    res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        ready
          ? { status: 'ok', agent: agentName, platform: 'slack' }
          : { status: 'starting' }
      )
    );
  });
  health.listen(port, () => log(`health on :${port} (connecting to Slack)`));

  log(`driving agent "${agentName}" (${agentState} state, ${streamMode} streaming)`);
  try {
    const auth = await app.client.auth.test();
    team = auth.team_id ?? '';
    bot.userId = auth.user_id;
    bot.botId = auth.bot_id;
    // A token missing scopes connects fine but never sees the events it needs.
    const granted = auth.response_metadata?.scopes ?? [];
    const missing = REQUIRED_SCOPES.filter((s) => !granted.includes(s));
    if (granted.length > 0 && missing.length > 0) {
      console.warn(
        `[channel:slack] the bot token lacks scopes: ${missing.join(', ')}. ` +
          `Add them under OAuth & Permissions, then reinstall the app.`
      );
    }
    await app.start();
    ready = true;
    log(`ready as @${auth.user} in ${auth.team} (bot user ${bot.userId})`);
    log(
      'waiting for events. If nothing shows up when you @mention or DM the ' +
        'bot, check Event Subscriptions (app_mention, message.im, ' +
        'message.channels) and that the bot was invited to the channel.'
    );
  } catch (e) {
    console.error(`[channel:slack] ${(e as Error).message}`);
    await channel.close();
    process.exit(1);
  }

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    log(`${signal} received, shutting down`);
    health.close();
    await app.stop().catch(() => {});
    // Let turns in progress finish (or cut them after 10s) before the app's
    // box goes away.
    await conversations.close();
    await channel.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('[channel:slack] fatal', e);
  process.exit(1);
});
