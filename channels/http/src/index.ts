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
 * HTTP channel entry point.
 *
 * Exposes each flow and agent the deployment lists in `expose` as a POST
 * endpoint:
 *
 *   POST /<flow>    { "data": <input> }               -> { "result": <output> }
 *   POST /<agent>   { "message": "hi", "sessionId"? } -> { "result": { text, sessionId, ... } }
 *
 * Add `?stream=true` for newline-delimited JSON chunks followed by a final
 * `{ "result": ... }` line.
 *
 * With `expose.contextProvider` set, every request first goes through the
 * app's context provider (method, headers, body); a refusal becomes a 401 or
 * 403, and the resulting context rides along on the call.
 *
 * Routes come from config, not discovery: the app runs in a box that may not
 * be running yet (or may run per session), so the channel never asks it what
 * it has. `initChannel()` hands back lazy proxies; the box starts on the first
 * request.
 */

import express, {
  type Express,
  type Request,
  type Response,
} from 'express';
import {
  errorStatus,
  httpStatusFor,
  initChannel,
  type ActionContext,
  type AgentChat,
  type Channel,
  type SessionState,
} from 'genkit-channels';
import { randomUUID } from 'node:crypto';

interface Route {
  kind: 'flow' | 'agent';
  name: string;
}

async function main(): Promise<void> {
  const channel = initChannel();
  const routes = new Map<string, Route>();
  for (const name of channel.expose.flows) {
    routes.set(`/${name}`, { kind: 'flow', name });
  }
  for (const name of channel.expose.agents) {
    routes.set(`/${name}`, { kind: 'agent', name });
  }
  if (routes.size === 0) {
    console.error(
      '[channel:http] nothing to expose; list agents/flows under ' +
        '`expose` in channels.yaml.'
    );
    process.exit(1);
  }

  const server: Express = express();
  server.use(express.json({ limit: '10mb' }));

  server.get('/', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      endpoints: [...routes].map(([path, r]) => ({ path, kind: r.kind })),
    });
  });

  server.post(/.*/, async (req: Request, res: Response) => {
    const route = routes.get(req.path);
    if (!route) {
      res.status(404).json({ error: { message: `no route ${req.path}` } });
      return;
    }
    // A client disconnect cancels the action in the box.
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });
    const stream = req.query.stream === 'true' || req.query.stream === '1';
    try {
      // `{}` when the deployment has no context provider.
      const context = await channel.context({
        method: req.method,
        headers: req.headers,
        input: req.body,
      });
      const call: Call = { req, res, stream, abortSignal: ac.signal, context };
      if (route.kind === 'flow') {
        await handleFlow(channel, route.name, call);
      } else {
        await handleAgent(channel, route.name, call);
      }
    } catch (e) {
      sendError(res, e);
    }
  });

  const port = Number(process.env.PORT) || 8080;
  const httpServer = server.listen(port, () => {
    console.log(`[channel:http] listening on :${port}`);
    for (const [path, r] of routes) {
      console.log(`  POST ${path}  -> ${r.kind} ${r.name}`);
    }
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    console.log(`[channel:http] ${signal} received, shutting down`);
    httpServer.close();
    await channel.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/** One request, after the context provider let it through. */
interface Call {
  req: Request;
  res: Response;
  stream: boolean;
  abortSignal: AbortSignal;
  context: ActionContext;
}

async function handleFlow(
  channel: Channel,
  name: string,
  { req, res, stream, abortSignal, context }: Call
): Promise<void> {
  const flow = channel.flow(name);
  const input: unknown = req.body?.data ?? req.body;
  if (!stream) {
    const { result } = await flow.run(input, { abortSignal, context });
    res.json({ result });
    return;
  }
  startStream(res);
  const { stream: chunks, output } = flow.stream(input, { abortSignal, context });
  for await (const chunk of chunks) res.write(JSON.stringify(chunk) + '\n');
  res.end(JSON.stringify({ result: await output }) + '\n');
}

/** What an agent request carries. */
interface AgentRequestBody {
  message?: unknown;
  /** Server-managed agents: continue this conversation. */
  sessionId?: unknown;
  /** Client-managed agents: the `state` from the previous response. */
  state?: unknown;
}

/**
 * One agent turn. Server-managed agents continue a conversation by
 * `sessionId` (generated on the first turn and returned); client-managed
 * agents expect the caller to send back the `state` from the previous
 * response.
 */
async function handleAgent(
  channel: Channel,
  name: string,
  { req, res, stream, abortSignal, context }: Call
): Promise<void> {
  const body: AgentRequestBody = req.body ?? {};
  if (typeof body.message !== 'string' || !body.message) {
    res
      .status(400)
      .json({ error: { message: '`message` (string) is required' } });
    return;
  }
  // The state blob is opaque to the channel; the agent validates it.
  const state = isObject(body.state) ? (body.state as SessionState) : undefined;
  // Pick the session id up front (rather than letting the agent mint one) so
  // even the first turn routes to the conversation's box under
  // `box.route: session`. Callers send it back to continue.
  const sessionId =
    typeof body.sessionId === 'string'
      ? body.sessionId
      : (state?.sessionId ?? randomUUID());
  const agent = channel.agent(name, { sessionId, context });
  const chat: AgentChat =
    channel.agentState(name) === 'client'
      ? agent.chat(state ? { state } : undefined)
      : agent.chat({ sessionId });

  const turn = chat.sendStream(body.message, { abortSignal });
  if (stream) {
    startStream(res);
    for await (const chunk of turn.stream) {
      if (chunk.text) res.write(JSON.stringify({ text: chunk.text }) + '\n');
    }
  }
  const response = await turn.response;
  const result = {
    text: response.text,
    finishReason: response.finishReason,
    sessionId: response.sessionId ?? sessionId,
    snapshotId: response.snapshotId,
    state: response.raw.state,
  };
  if (stream) res.end(JSON.stringify({ result }) + '\n');
  else res.json({ result });
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function startStream(res: Response): void {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
}

/**
 * Callers here are programs, so the app's message and status go out as is
 * (`{ error: { message, status: 'RESOURCE_EXHAUSTED' } }`). Chat channels use
 * describeFailure instead, to show people something friendlier.
 */
function sendError(res: Response, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  const error = { message, status: errorStatus(e) ?? 'INTERNAL' };
  if (!res.headersSent) {
    // UNAUTHENTICATED 401, PERMISSION_DENIED 403, RESOURCE_EXHAUSTED 429,
    // ..., anything else 500.
    res.status(httpStatusFor(e)).json({ error });
  } else if (!res.writableEnded) {
    // Mid-stream: the status line is gone, so the last NDJSON line says it.
    res.end(JSON.stringify({ error }) + '\n');
  }
}

main().catch((e) => {
  console.error('[channel:http] fatal', e);
  process.exit(1);
});
