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
 * in for a real app (JS/Go/Python) so the channel + app-process helper can be
 * exercised without building the full framework. It connects to
 * GENKIT_REFLECTION_V2_SERVER, registers, answers listActions, and echoes
 * runAction (with streaming).
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

const ACTIONS = {
  '/flow/echo': { key: '/flow/echo', name: 'echo' },
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
      id: String(process.pid),
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

    // Agent snapshot companion: return the stored session state, if any.
    if (key === '/agent-snapshot/echoAgent') {
      const lookup = input || {};
      const snap = lookup.sessionId
        ? sessions.get(lookup.sessionId)
        : undefined;
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
        const sessionId = init?.sessionId ?? init?.state?.sessionId;
        const snapshotId = `snap-${msg.id}`;
        const prev = (sessionId && sessions.get(sessionId)?.messages) || [];
        const messages = [
          ...prev,
          input?.message ?? { role: 'user', content: [{ text }] },
          message,
        ];
        if (sessionId) sessions.set(sessionId, { sessionId, messages });
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
