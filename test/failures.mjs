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
 * How failures in the app reach a channel, over both box runners (exec and
 * remote), and how describeFailure / httpStatusFor classify them. The app is
 * test/fixtures/failing-app.mjs. Run after `pnpm build`:
 *
 *   node test/failures.mjs
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeFailure } from '../dist/chat/index.js';
import { httpStatusFor, initChannel } from '../dist/index.js';
import { check, run } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const failingApp = path.join(here, 'fixtures', 'failing-app.mjs');

const AGENTS = ['rateLimited', 'blocked', 'misconfigured', 'midStream', 'crashes'];

/** Streams one turn; returns what streamed and the error it ended with. */
async function failTurn(channel, agent) {
  const turn = channel.agent(agent).chat({}).sendStream('hi');
  let streamed = '';
  let error;
  try {
    for await (const chunk of turn.stream) streamed += chunk.text ?? '';
    await turn.response;
  } catch (e) {
    error = e;
  }
  await turn.response.catch(() => {});
  return { streamed, error };
}

async function exercise(label, channel) {
  const expected = {
    rateLimited: ['rate-limited', 429],
    blocked: ['blocked', 400],
    misconfigured: ['config', 400],
    midStream: ['unexpected', 500],
    crashes: ['unexpected', 500],
  };
  for (const [agent, [kind, http]] of Object.entries(expected)) {
    const { streamed, error } = await failTurn(channel, agent);
    const f = describeFailure(error);
    check(`[${label}] ${agent}: ${kind}`, f.kind === kind);
    check(`[${label}] ${agent}: HTTP ${http}`, httpStatusFor(error) === http);
    if (agent === 'midStream') {
      check(`[${label}] a mid-stream failure keeps what streamed`, streamed === 'partial reply');
    }
    if (agent === 'crashes') {
      check(
        `[${label}] the log keeps the app's message, the user doesn't see it`,
        f.logMessage.includes("reading 'x'") && !f.userMessage.includes("reading 'x'")
      );
    }
  }
  const unknown = await failTurn(channel, 'noSuchAgent');
  check(`[${label}] an unknown agent is a config error`, describeFailure(unknown.error).kind === 'config');
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

async function viaExec() {
  const channel = initChannel({
    config: {
      expose: { agents: AGENTS },
      box: { runner: { type: 'exec', cmd: ['node', failingApp] } },
    },
  });
  try {
    await exercise('exec', channel);
  } finally {
    await channel.close();
  }
}

async function viaRemote() {
  const port = await freePort();
  const secret = randomBytes(16).toString('hex');
  const app = spawn('node', [failingApp], {
    env: {
      ...process.env,
      GENKIT_REFLECTION_ENABLED: 'true',
      GENKIT_REFLECTION_PORT: String(port),
      GENKIT_REFLECTION_SECRET_TOKEN: secret,
      GENKIT_REFLECTION_V2_SERVER: '',
    },
    stdio: 'ignore',
  });
  process.env.TEST_REFLECTION_SECRET = secret;
  const channel = initChannel({
    config: {
      expose: { agents: AGENTS },
      box: {
        runner: { type: 'remote', url: `http://127.0.0.1:${port}`, secretEnv: 'TEST_REFLECTION_SECRET' },
      },
    },
  });
  try {
    await exercise('remote', channel);
  } finally {
    await channel.close();
    const exited = new Promise((r) => app.once('exit', r));
    app.kill();
    await exited;
  }
}

async function appDown() {
  // The app exits before it connects.
  process.env.FAIL_ON_START = '1';
  const crashed = initChannel({
    config: {
      expose: { agents: AGENTS },
      box: { runner: { type: 'exec', cmd: ['node', failingApp] } },
    },
  });
  try {
    const { error } = await failTurn(crashed, 'crashes');
    check('an app that exits on start is unavailable', describeFailure(error).kind === 'unavailable');
  } finally {
    await crashed.close();
    delete process.env.FAIL_ON_START;
  }

  // Nothing listens where the remote app should be.
  process.env.TEST_REFLECTION_SECRET = 'x';
  const unreachable = initChannel({
    config: {
      expose: { agents: AGENTS },
      box: {
        runner: {
          type: 'remote',
          url: `http://127.0.0.1:${await freePort()}`,
          secretEnv: 'TEST_REFLECTION_SECRET',
          readyTimeout: '2s',
        },
      },
    },
  });
  try {
    const { error } = await failTurn(unreachable, 'crashes');
    check('an unreachable app is unavailable', describeFailure(error).kind === 'unavailable');
  } finally {
    await unreachable.close();
  }
}

function overrides() {
  const f = describeFailure(new Error('boom'), { unexpected: 'Oops.' });
  check('user messages can be overridden per kind', f.userMessage === 'Oops.' && f.kind === 'unexpected');
}

run('failures', async () => {
  await viaExec();
  await viaRemote();
  await appDown();
  overrides();
});
