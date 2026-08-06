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
 * Runs the user's Genkit app as a child process, discovers its actions over
 * reflection v2, and exposes each flow/agent as an HTTP endpoint. There is no
 * codegen and no import of user code: routing is built at runtime from
 * `listActions`, so the same channel works against a JS, Go, or Python app.
 *
 * The heavy lifting (reading channel.config.json, spawning the app, speaking
 * reflection v2) lives in the genkit-channels helper library; a channel only
 * maps a transport onto the discovered actions.
 */

import express from 'express';
import { startAppProcess } from 'genkit-channels';

/**
 * Derives an HTTP route + short name from an action key. Keys look like
 * `/flow/<name>` or `/agent/<name>` (possibly namespaced). We only expose
 * flows and agents.
 */
function routeForAction(key) {
  const m = /^\/(flow|agent)\/(.+)$/.exec(key);
  if (!m) return null;
  const kind = m[1];
  const name = m[2];
  return { kind, name, path: `/${name}` };
}

/** Applies the optional expose filter. */
function shouldExpose(route, expose) {
  const agents = expose.agents || [];
  const flows = expose.flows || [];
  if (agents.length === 0 && flows.length === 0) return true;
  if (route.kind === 'agent') return agents.includes(route.name);
  if (route.kind === 'flow') return flows.includes(route.name);
  return false;
}

async function main() {
  // The framework reads channel.config.json for us: managed vs attached mode,
  // how to spawn the child, and the ready timeout. Starting is synchronous.
  const app = startAppProcess();
  const { expose } = await app.getConfig();

  // Readiness gate. In attached (sidecar) mode we must start the HTTP ingress
  // immediately so the platform's startup probe and dependsOn ordering work,
  // but we return 503 until the app has connected and we have discovered its
  // actions. In managed mode we could block first, but using the same gate
  // keeps one code path and improves cold-start behavior.
  let ready = false;
  let routes = [];

  const server = express();
  server.use(express.json({ limit: '10mb' }));

  // Health/readiness endpoint. 200 once ready, 503 while starting up.
  server.get('/', (_req, res) => {
    if (!ready) {
      res.status(503).json({ status: 'starting' });
      return;
    }
    res.json({
      status: 'ok',
      endpoints: routes.map((r) => ({ path: r.path, kind: r.kind })),
    });
  });

  // A single dynamic POST handler dispatches to the discovered route so we do
  // not need to register routes before the app connects.
  server.post(/.*/, async (req, res) => {
    if (!ready) {
      res.status(503).json({ error: { message: 'channel starting up' } });
      return;
    }
    const route = routes.find((r) => r.path === req.path);
    if (!route) {
      res.status(404).json({ error: { message: `no route ${req.path}` } });
      return;
    }
    await handleAction(app, route, req, res);
  });

  const port = Number(process.env.PORT) || 8080;
  const httpServer = server.listen(port, () => {
    console.log(
      `[channel:http] listening on :${port} (waiting for app to register)`
    );
  });

  // Wait for the app to connect + register, then discover actions.
  try {
    const actions = await app.listActions();
    routes = [];
    for (const key of Object.keys(actions)) {
      const route = routeForAction(key);
      if (route && shouldExpose(route, expose)) {
        routes.push({ ...route, key });
      }
    }
    ready = true;
    console.log(`[channel:http] ready (${routes.length} endpoint(s))`);
    for (const r of routes) console.log(`  POST ${r.path}  -> ${r.key}`);
  } catch (e) {
    console.error(`[channel:http] ${e.message}`);
    await app.stop();
    process.exit(1);
  }

  const shutdown = async (signal) => {
    console.log(`[channel:http] ${signal} received, shutting down`);
    httpServer.close();
    await app.stop(signal);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/** Runs a discovered action for an HTTP request, streaming when asked. */
async function handleAction(app, route, req, res) {
  const wantStream = req.query.stream === 'true' || req.query.stream === '1';

  // Map client disconnect to action cancellation.
  let traceId;
  req.on('close', () => {
    if (traceId && !res.writableEnded) app.cancelAction(traceId);
  });

  try {
    if (wantStream) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Transfer-Encoding', 'chunked');
      const { result } = await app.runAction({
        key: route.key,
        input: req.body?.data ?? req.body,
        onChunk: (chunk) => {
          res.write(JSON.stringify(chunk) + '\n');
        },
        onTraceId: (tid) => {
          traceId = tid;
        },
      });
      res.write(JSON.stringify({ result }) + '\n');
      res.end();
    } else {
      const { result } = await app.runAction({
        key: route.key,
        input: req.body?.data ?? req.body,
        onTraceId: (tid) => {
          traceId = tid;
        },
      });
      res.json({ result });
    }
  } catch (e) {
    const status = e?.data?.code === 3 ? 400 : 500;
    if (!res.headersSent) {
      res.status(status).json({ error: { message: e.message } });
    } else if (!res.writableEnded) {
      res.write(JSON.stringify({ error: { message: e.message } }) + '\n');
      res.end();
    }
  }
}


main().catch((e) => {
  console.error('[channel:http] fatal', e);
  process.exit(1);
});
