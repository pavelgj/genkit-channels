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
 * initChannel against a real Genkit app (test/fixtures/echo-app.mjs, echo
 * model, no API key), over both transports:
 *  - exec runner: box spawns the app, which dials back over reflection v2,
 *  - remote runner: the app is started separately and serves v1 reflection
 *    on a port with a secret, the way the Cloud Run sidecar runs (box
 *    remoteRunner).
 * Run after `pnpm build`:
 *
 *   node test/real-app.mjs
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initChannel } from '../dist/index.js';
import { check, drain, run } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const echoApp = path.join(here, 'fixtures', 'echo-app.mjs');

async function exercise(label, channel) {
  const agent = channel.agent('echoAgent');
  const chat = agent.chat();
  const turn = chat.sendStream('hello');
  const streamed = await drain(turn);
  const res = await turn.response;
  check(`[${label}] agent turn echoes`, res.text === 'echo:hello');
  check(`[${label}] agent turn streamed`, streamed.includes('echo:hello'));
  check(`[${label}] server-managed session minted`, !!res.sessionId && !!res.snapshotId);

  const res2 = await chat.send('again');
  check(`[${label}] follow-up resumes the session`, res2.sessionId === res.sessionId);
  check(`[${label}] history has both turns`, res2.messages.length >= 4);

  const { stream, output } = channel.flow('countTo').stream({ n: 3 });
  const chunks = [];
  for await (const c of stream) chunks.push(c.i);
  check(`[${label}] flow streams chunks`, chunks.join(',') === '1,2,3');
  check(`[${label}] flow returns output`, (await output).total === 3);

  // A pre-aborted call settles (rejects or finishes) instead of hanging.
  const ac = new AbortController();
  ac.abort();
  const settled = await Promise.race([
    channel
      .flow('countTo')
      .run({ n: 1 }, { abortSignal: ac.signal })
      .then(() => true, () => true),
    new Promise((r) => setTimeout(() => r(false), 5000)),
  ]);
  check(`[${label}] pre-aborted call settles`, settled);
}

async function viaExec() {
  const channel = initChannel({
    config: {
      expose: { agents: ['echoAgent'], flows: ['countTo'] },
      box: { runner: { type: 'exec', cmd: ['node', echoApp] } },
    },
  });
  await exercise('exec', channel);
  await channel.close();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function viaRemote() {
  const port = await freePort();
  const secret = randomBytes(16).toString('hex');
  const app = spawn('node', [echoApp], {
    env: {
      ...process.env,
      GENKIT_REFLECTION_ENABLED: 'true',
      GENKIT_REFLECTION_PORT: String(port),
      GENKIT_REFLECTION_SECRET_TOKEN: secret,
      GENKIT_REFLECTION_V2_SERVER: '',
    },
    stdio: 'ignore',
  });
  try {
    process.env.TEST_REFLECTION_SECRET = secret;
    const channel = initChannel({
      config: {
        expose: { agents: ['echoAgent'], flows: ['countTo'] },
        box: {
          runner: {
            type: 'remote',
            url: `http://127.0.0.1:${port}`,
            secretEnv: 'TEST_REFLECTION_SECRET',
          },
        },
      },
    });
    await exercise('remote', channel);
    await channel.close();

    // Without the secret the app refuses the call.
    delete process.env.TEST_REFLECTION_SECRET;
    const unauthed = initChannel({
      config: {
        expose: { flows: ['countTo'] },
        box: {
          runner: {
            type: 'remote',
            url: `http://127.0.0.1:${port}`,
            secretEnv: 'TEST_REFLECTION_SECRET',
            readyTimeout: '3s',
          },
        },
      },
    });
    let rejected = false;
    try {
      await unauthed.flow('countTo').run({ n: 1 });
    } catch {
      rejected = true;
    }
    check('[remote] calls without the secret are rejected', rejected);
    await unauthed.close();
  } finally {
    const exited = new Promise((r) => app.once('exit', r));
    app.kill();
    await exited;
  }
}

run('real-app', async () => {
  await viaExec();
  await viaRemote();
});
