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
 * A minimal fake Genkit runtime: the *client* half of reflection v2. It stands
 * in for a real app (JS/Go/Python) so channels can be exercised without the
 * full framework. Speaks the same contract a real runtime does under a box
 * exec runner: dials GENKIT_REFLECTION_V2_SERVER, registers with
 * GENKIT_RUNTIME_ID and GENKIT_REFLECTION_SECRET_TOKEN, answers listActions,
 * and echoes runAction (with streaming).
 *
 * Test hooks:
 *  - `/flow/probe` returns this process's pid, the names of a few env vars it
 *    can see, and how many listActions calls it has served.
 *  - `/flow/contextProvider/auth` is a context provider (`Bearer ok` passes);
 *    `/flow/whoami` returns the action context it was called with.
 *  - FAKE_AGENT_STATE=client makes echoAgent client-managed.
 */

import WebSocket from 'ws';

const url = process.env.GENKIT_REFLECTION_V2_SERVER;
if (!url) {
  console.error('fake-runtime: GENKIT_REFLECTION_V2_SERVER not set');
  process.exit(1);
}

// The agent kind (server- vs client-managed) can be toggled from the test via
// the FAKE_AGENT_STATE env var so one fake runtime exercises both paths.
const AGENT_STATE = process.env.FAKE_AGENT_STATE === 'client' ? 'client' : 'server';

let listActionsCalls = 0;

const ACTIONS = {
  '/flow/echo': { key: '/flow/echo', name: 'echo' },
  '/flow/probe': { key: '/flow/probe', name: 'probe' },
  '/agent/weatherAgent': { key: '/agent/weatherAgent', name: 'weatherAgent' },
  // An agent action carries capability metadata under `metadata.agent`, which
  // the channel's agent client reads to decide server- vs client-managed state.
  '/agent/echoAgent': {
    key: '/agent/echoAgent',
    name: 'echoAgent',
    actionType: 'agent',
    metadata: {
      agent: {
        stateManagement: AGENT_STATE,
        abortable: AGENT_STATE === 'server',
      },
    },
  },
  '/agent-snapshot/echoAgent': {
    key: '/agent-snapshot/echoAgent',
    name: 'echoAgent',
    actionType: 'agent-snapshot',
  },
  '/agent-abort/echoAgent': {
    key: '/agent-abort/echoAgent',
    name: 'echoAgent',
    actionType: 'agent-abort',
  },
};

// A trivial in-memory session store so server-managed turns accumulate history
// keyed by sessionId, mirroring what a real agent store does.
const sessions = new Map();
/** snapshotId -> sessionId, so snapshot-only resumes find their session. */
const snapshots = new Map();

/** Extracts the user's text from an AgentInput message. */
function inputText(input) {
  const parts = input?.message?.content ?? [];
  return parts.map((p) => p.text ?? '').join('');
}


const ws = new WebSocket(url);
let reqId = 0;

function send(obj) {
  ws.send(JSON.stringify(obj));
}

ws.on('open', () => {
  // register (request from runtime -> manager)
  send({
    jsonrpc: '2.0',
    method: 'register',
    params: {
      id: process.env.GENKIT_RUNTIME_ID || String(process.pid),
      secret: process.env.GENKIT_REFLECTION_SECRET_TOKEN,
      pid: process.pid,
      name: 'fake-runtime',
      genkitVersion: 'fake/0.0.0',
      reflectionApiSpecVersion: 1,
      envs: ['dev'],
    },
    id: String(++reqId),
  });
});

ws.on('message', async (data) => {
  const msg = JSON.parse(data.toString());
  if (!('method' in msg)) return; // response to our register; ignore

  if (msg.method === 'listActions') {
    listActionsCalls++;
    send({ jsonrpc: '2.0', result: { actions: ACTIONS }, id: msg.id });
    return;
  }

  if (msg.method === 'runAction') {
    const { key, input, init, stream } = msg.params || {};
    const traceId = `trace-${msg.id}`;
    // Early trace id.
    send({
      jsonrpc: '2.0',
      method: 'runActionState',
      params: { requestId: msg.id, state: { traceId } },
    });

    // A context provider (what defineContextProvider registers): `Bearer ok`
    // passes, a missing header is UNAUTHENTICATED (16), anything else is
    // PERMISSION_DENIED (7). Errors use the wire shape a real runtime sends.
    if (key === '/flow/contextProvider/auth') {
      const auth = input?.headers?.authorization;
      if (auth === 'Bearer ok') {
        send({
          jsonrpc: '2.0',
          result: {
            result: {
              auth: { uid: input.channel?.user?.id ?? 'http-user' },
              providerPid: process.pid,
              seenRequest: input,
            },
            telemetry: { traceId },
          },
          id: msg.id,
        });
      } else {
        const [code, status] = auth ? [7, 'PERMISSION_DENIED'] : [16, 'UNAUTHENTICATED'];
        send({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: `${status}: nope`,
            data: { code, message: `${status}: nope` },
          },
          id: msg.id,
        });
      }
      return;
    }

    // Returns the action context the call carried.
    if (key === '/flow/whoami') {
      send({
        jsonrpc: '2.0',
        result: { result: { context: msg.params.context ?? null }, telemetry: { traceId } },
        id: msg.id,
      });
      return;
    }

    if (key === '/flow/probe') {
      const names = Array.isArray(input?.env) ? input.env : [];
      send({
        jsonrpc: '2.0',
        result: {
          result: {
            pid: process.pid,
            env: Object.fromEntries(names.map((n) => [n, n in process.env])),
            listActionsCalls,
          },
          telemetry: { traceId },
        },
        id: msg.id,
      });
      return;
    }

    // Agent snapshot companion: return the stored session state, if any.
    if (key === '/agent-snapshot/echoAgent') {
      const lookup = input || {};
      const sessionId = lookup.sessionId ?? snapshots.get(lookup.snapshotId);
      const snap = sessionId ? sessions.get(sessionId) : undefined;
      send({ jsonrpc: '2.0', result: { result: snap }, id: msg.id });
      return;
    }

    // Agent abort companion.
    if (key === '/agent-abort/echoAgent') {
      send({
        jsonrpc: '2.0',
        result: { result: { snapshotId: input?.snapshotId, status: 'aborted' } },
        id: msg.id,
      });
      return;
    }

    // The echo agent: emit AgentStreamChunks then a final AgentOutput. The
    // reply echoes the user's text so the test can assert on it.
    if (key === '/agent/echoAgent') {
      const text = inputText(input);
      const reply = `echo: ${text}`;
      if (stream) {
        for (const word of reply.split(' ')) {
          send({
            jsonrpc: '2.0',
            method: 'streamChunk',
            params: {
              requestId: msg.id,
              // AgentStreamChunk shape: text lives under modelChunk.content.
              chunk: { modelChunk: { content: [{ text: word + ' ' }] } },
            },
          });
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      const message = { role: 'model', content: [{ text: reply }] };
      const output = { message, finishReason: 'stop' };
      if (AGENT_STATE === 'server') {
        // Server-managed: persist history keyed by sessionId, return snapshotId.
        // Like a real store, a resume by snapshotId alone finds its session,
        // and a first turn without one mints a session id.
        const sessionId =
          init?.sessionId ??
          snapshots.get(init?.snapshotId) ??
          `session-${process.pid}-${msg.id}`;
        const snapshotId = `snap-${process.pid}-${msg.id}`;
        snapshots.set(snapshotId, sessionId);
        const prev = sessions.get(sessionId)?.state.messages ?? [];
        const messages = [
          ...prev,
          input?.message ?? { role: 'user', content: [{ text }] },
          message,
        ];
        // Same shape as a real SessionSnapshot (messages under `state`), plus
        // the serving pid so tests can tell boxes apart.
        sessions.set(sessionId, {
          snapshotId,
          sessionId,
          state: { sessionId, messages },
          pid: process.pid,
        });
        output.sessionId = sessionId;
        output.snapshotId = snapshotId;
      } else {
        // Client-managed: return the full session state blob on the wire.
        const prev = init?.state?.messages ?? [];
        const messages = [
          ...prev,
          input?.message ?? { role: 'user', content: [{ text }] },
          message,
        ];
        output.state = { messages, custom: { turns: messages.length / 2 } };
      }
      send({
        jsonrpc: '2.0',
        result: { result: output, telemetry: { traceId } },
        id: msg.id,
      });
      return;
    }

    // Generic flow/agent echo (used by the existing smoke tests).
    if (stream) {
      for (const word of ['hello', 'from', key]) {
        send({
          jsonrpc: '2.0',
          method: 'streamChunk',
          params: { requestId: msg.id, chunk: { text: word } },
        });
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    send({
      jsonrpc: '2.0',
      result: {
        result: { echoed: input, action: key },
        telemetry: { traceId },
      },
      id: msg.id,
    });
    return;
  }


  if (msg.method === 'cancelAction') {
    send({ jsonrpc: '2.0', result: { message: 'cancelled' }, id: msg.id });
    return;
  }
});

ws.on('error', (e) => {
  console.error('fake-runtime: ws error', e.message);
});

// Keep the process alive (headless).
setInterval(() => {}, 1 << 30);
