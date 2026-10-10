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
import { createServer } from 'node:http';
import {
  type IncomingEvent,
  KeyedQueue,
  type Trigger,
  mentionTrigger,
  messageTrigger,
  sessionKey,
  uuidv5,
} from './bridge.js';
import { editReply, nativeStreamReply, type ReplyTarget } from './slack-reply.js';
import { type ClientStateStore, runTurn } from './turn.js';

/** Slack-specific options (the deployment's `with` block). */
interface SlackOptions {
  /** Keep answering in a thread once the bot has replied there. Default true. */
  followThreads?: boolean;
  /** `native` (Slack text streaming, default) or `edit` (debounced updates). */
  stream?: 'native' | 'edit';
  /** Debounce for `stream: edit`. Default 700ms. */
  streamEditIntervalMs?: number;
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

  // Threads the bot has answered in, for `followThreads`. In memory: after a
  // restart the bot needs a fresh @mention to pick a thread back up (the
  // conversation itself is kept, since session ids derive from the thread).
  const followed = new Set<string>();
  const clientState: ClientStateStore = new Map();
  const queue = new KeyedQueue();
  let team = '';
  let botUserId: string | undefined;

  function handle(ev: IncomingEvent, trigger: Trigger, eventTeam?: string) {
    const teamId = eventTeam || team;
    const key = sessionKey(teamId, ev.channel, trigger.threadTs);
    followed.add(`${ev.channel}:${trigger.threadTs}`);
    const target: ReplyTarget = {
      channel: ev.channel,
      threadTs: trigger.threadTs,
      user: ev.user,
      team: teamId,
    };
    const sessionId = uuidv5(key);
    // One turn at a time per thread; queued messages run in order.
    return queue.run(key, async () => {
      const started = Date.now();
      log(`turn start: thread ${trigger.threadTs}`);
      const res = await runTurn({
        // One handle per conversation, so `box.route: session` gives each
        // thread its own box.
        agent: channel.agent(agentName, { sessionId }),
        agentState,
        sessionKey: key,
        sessionId,
        input: trigger.text,
        reply:
          streamMode === 'edit'
            ? editReply(app.client, target, editIntervalMs)
            : nativeStreamReply(app.client, target),
        clientState,
        log,
      });
      log(
        `turn ${res ? 'done' : 'failed'}: thread ${trigger.threadTs} ` +
          `(${Date.now() - started}ms)`
      );
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
    const trigger = mentionTrigger(ev, context.botUserId ?? botUserId);
    log(`app_mention in ${ev.channel} from ${ev.user ?? '?'}${trigger ? '' : ' (ignored)'}`);
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
    const trigger = messageTrigger(ev, {
      botUserId: context.botUserId ?? botUserId,
      followThreads,
      isFollowed: (threadTs) => followed.has(`${ev.channel}:${threadTs}`),
    });
    // Channel chatter is the common case; only log what we act on, and DMs.
    if (trigger || ev.channelType === 'im') {
      log(
        `message (${ev.channelType}) in ${ev.channel} from ${ev.user ?? '?'}` +
          (trigger ? '' : ' (ignored)')
      );
    }
    if (trigger) void handle(ev, trigger, context.teamId);
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
    botUserId = auth.user_id;
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
    log(`ready as @${auth.user} in ${auth.team} (bot user ${botUserId})`);
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
