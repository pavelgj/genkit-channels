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
 * Dev UI proxy smoke test: the `genkit start` scenario in miniature.
 *
 * When the channel is launched under `genkit start`, the dev UI runs its own
 * reflection v2 server and passes its URL in GENKIT_REFLECTION_V2_SERVER. The
 * channel still spawns the runtime as a child (managed mode), so without a proxy
 * the runtime would only be visible to the channel, never the dev UI. This test
 * stands up a fake dev UI server, sets that env var, starts the app process with
 * the fake runtime, and asserts the channel:
 *   - registers the runtime with the dev UI (forwarding its identity), and
 *   - relays listActions and a streaming runAction issued by the dev UI.
 *
 * Meanwhile the channel's own link to the runtime must keep working.
 *
 * Run after `pnpm build`:
 *   node test/smoke-devui-proxy.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { startAppProcess } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeRuntime = path.join(here, 'fake-runtime.mjs');

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
}

/**
 * A minimal stand-in for the dev UI's reflection v2 server. It accepts one
 * connection (the channel acting as proxy), exposes a `request` helper that
 * sends a JSON-RPC request and resolves on the correlated response, and collects
 * `streamChunk` notifications keyed by request id.
 */
function startFakeDevUi() {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const state = {
      register: null,
      chunks: new Map(),
      pending: new Map(),
      nextId: 0,
      ws: null,
    };

    wss.on('connection', (ws) => {
      state.ws = ws;
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'register') {
          state.register = msg.params;
          // Ack the registration like the real dev UI would.
          ws.send(JSON.stringify({ jsonrpc: '2.0', result: {}, id: msg.id }));
          return;
        }
        if (msg.method === 'streamChunk') {
          const { requestId, chunk } = msg.params || {};
          const list = state.chunks.get(String(requestId)) || [];
          list.push(chunk);
          state.chunks.set(String(requestId), list);
          return;
        }
        if (msg.method === 'runActionState') return; // trace id notice, ignore
        if (msg.id !== undefined && msg.id !== null) {
          const pending = state.pending.get(String(msg.id));
          if (pending) {
            state.pending.delete(String(msg.id));
            if (msg.error) pending.reject(new Error(msg.error.message));
            else pending.resolve(msg.result);
          }
        }
      });
    });

    wss.on('listening', () => {
      const { port } = wss.address();
      const api = {
        url: `ws://127.0.0.1:${port}`,
        get register() {
          return state.register;
        },
        chunksFor(id) {
          return state.chunks.get(String(id)) || [];
        },
        request(method, params) {
          return api.requestWithId(method, params).promise;
        },
        /**
         * Like {@link request} but exposes the assigned id alongside the promise
         * so callers can correlate streamed `streamChunk` notifications.
         */
        requestWithId(method, params) {
          const id = String(++state.nextId);
          const promise = new Promise((res, rej) => {
            state.pending.set(id, { resolve: res, reject: rej });
            state.ws.send(
              JSON.stringify({ jsonrpc: '2.0', method, params, id })
            );
          });
          return { id, promise };
        },

        async waitForRegister(timeoutMs = 5000) {
          const start = Date.now();
          while (!state.register) {
            if (Date.now() - start > timeoutMs) {
              throw new Error('timed out waiting for register');
            }
            await new Promise((r) => setTimeout(r, 20));
          }
        },
        close() {
          wss.close();
        },
      };
      resolve(api);
    });
  });
}

async function main() {
  const devUi = await startFakeDevUi();

  // Simulate `genkit start`: the dev UI's reflection server URL is in the env
  // the channel process inherits.
  process.env.GENKIT_REFLECTION_V2_SERVER = devUi.url;

  const app = startAppProcess({
    child: { command: 'node', args: [fakeRuntime] },
    readyTimeoutMs: 10000,
  });

  try {
    await app.ready;

    // The channel's own link still works.
    const actions = await app.listActions();
    check('channel link still lists actions', !!actions['/flow/echo']);

    // The channel registered the runtime with the dev UI, forwarding identity.
    await devUi.waitForRegister();
    check('dev UI received a registration', !!devUi.register);
    check(
      'dev UI registration carries the runtime name',
      devUi.register?.name === 'fake-runtime'
    );

    // The dev UI can list actions through the proxy.
    const proxied = await devUi.request('listActions');
    check(
      'dev UI lists actions through the proxy',
      !!proxied?.actions?.['/flow/echo']
    );

    // The dev UI can run a non-streaming action through the proxy.
    const ran = await devUi.request('runAction', {
      key: '/flow/echo',
      input: { hello: 'devui' },
    });
    check(
      'dev UI runAction round-trips through the proxy',
      JSON.stringify(ran?.result?.echoed) === JSON.stringify({ hello: 'devui' })
    );

    // The dev UI can stream through the proxy: chunks route back to its id. The
    // fake runtime emits three chunks for a streaming weatherAgent run.
    const { id: streamId, promise: streamDone } = devUi.requestWithId(
      'runAction',
      { key: '/agent/weatherAgent', input: { q: 'weather?' }, stream: true }
    );
    await streamDone;
    check(
      'dev UI receives streamed chunks through the proxy',
      devUi.chunksFor(streamId).length === 3
    );

  } finally {
    await app.stop();
    devUi.close();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll dev UI proxy smoke checks passed.');
  process.exit(0);
}

main().catch((e) => {

  console.error('dev UI proxy smoke test crashed:', e);
  process.exit(1);
});
