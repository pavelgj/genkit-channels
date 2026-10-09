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
 * HTTP channel entry point (plain JS; see http-ts for the TypeScript variant).
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
 * Routes come from config, not discovery: the app runs in a box that may not
 * be running yet, so the channel never asks it what it has.
 */

import express from 'express';
import { initChannel } from 'genkit-channels';
import { randomUUID } from 'node:crypto';

async function main() {
  const channel = initChannel();
  const routes = new Map();
  for (const name of channel.expose.flows) {
    routes.set(`/${name}`, { kind: 'flow', name });
  }
  for (const name of channel.expose.agents) {
    routes.set(`/${name}`, { kind: 'agent', name });
  }
  if (routes.size === 0) {
    console.error(
      '[channel:http] nothing to expose; list agents/flows under `expose` ' +
        'in channels.yaml.'
    );
    process.exit(1);
  }

  const server = express();
  server.use(express.json({ limit: '10mb' }));

  server.get('/', (_req, res) => {
    res.json({
      status: 'ok',
      endpoints: [...routes].map(([path, r]) => ({ path, kind: r.kind })),
    });
  });

  server.post(/.*/, async (req, res) => {
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
      if (route.kind === 'flow') {
        await handleFlow(channel, route.name, req, res, stream, ac.signal);
      } else {
        await handleAgent(channel, route.name, req, res, stream, ac.signal);
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

  const shutdown = async (signal) => {
    console.log(`[channel:http] ${signal} received, shutting down`);
    httpServer.close();
    await channel.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function handleFlow(channel, name, req, res, stream, abortSignal) {
  const flow = channel.flow(name);
  const input = req.body?.data ?? req.body;
  if (!stream) {
    const { result } = await flow.run(input, { abortSignal });
    res.json({ result });
    return;
  }
  startStream(res);
  const { stream: chunks, output } = flow.stream(input, { abortSignal });
  for await (const chunk of chunks) res.write(JSON.stringify(chunk) + '\n');
  res.end(JSON.stringify({ result: await output }) + '\n');
}

/**
 * One agent turn. Server-managed agents continue a conversation by
 * `sessionId`; client-managed agents expect the caller to send back the
 * `state` from the previous response.
 */
async function handleAgent(channel, name, req, res, stream, abortSignal) {
  const body = req.body ?? {};
  if (typeof body.message !== 'string' || !body.message) {
    res
      .status(400)
      .json({ error: { message: '`message` (string) is required' } });
    return;
  }
  // Pick the session id up front so even the first turn routes to the
  // conversation's box under `box.route: session`.
  const sessionId = body.sessionId ?? body.state?.sessionId ?? randomUUID();
  const agent = channel.agent(name, { sessionId });
  const chat =
    channel.agentState(name) === 'client'
      ? agent.chat(body.state ? { state: body.state } : undefined)
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

function startStream(res) {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
}

function sendError(res, e) {
  const message = e?.message ?? String(e);
  // Reflection reports invalid input as status INVALID_ARGUMENT (code 3).
  const status = e?.data?.code === 3 ? 400 : 500;
  if (!res.headersSent) {
    res.status(status).json({ error: { message } });
  } else if (!res.writableEnded) {
    res.end(JSON.stringify({ error: { message } }) + '\n');
  }
}

main().catch((e) => {
  console.error('[channel:http] fatal', e);
  process.exit(1);
});
