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
 * Context providers (`expose.contextProvider` + `channel.context()`):
 *  - the fake runtime: request normalization, `{}` without a provider,
 *    UNAUTHENTICATED / PERMISSION_DENIED surviving the box hop, and the
 *    provider running on the shared box under `route: session`,
 *  - the real echo app (`defineContextProvider` from genkit-channels/app),
 *    over both the exec runner (v2) and the remote runner (v1), with the
 *    context reaching the app's flows.
 * Run after `pnpm build`:
 *
 *   node test/context.mjs
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  contextProviderFlowName,
  errorStatus,
  httpStatusFor,
  initChannel,
  isAuthError,
} from '../dist/index.js';
import { check, fakeRuntimeCmd, run } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const echoApp = path.join(here, 'fixtures', 'echo-app.mjs');

/** Resolves to the rejection, or undefined if `p` resolved. */
async function rejection(p) {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

async function withoutProvider() {
  const channel = initChannel({
    config: { box: { runner: { type: 'exec', cmd: ['false'] } } },
  });
  const context = await channel.context({ headers: { authorization: 'x' } });
  check('no provider: context() is {} and starts no box', JSON.stringify(context) === '{}');
  await channel.close();
}

async function fakeRuntime() {
  process.env.FAKE_AGENT_STATE = 'server';
  const channel = initChannel({
    config: {
      expose: { agents: ['echoAgent'], flows: ['probe', 'whoami'], contextProvider: 'auth' },
      box: { runner: { type: 'exec', cmd: fakeRuntimeCmd }, route: 'session' },
    },
  });
  check('expose carries contextProvider', channel.expose.contextProvider === 'auth');

  // Node-style headers: mixed case, array values. Express-style lowercase method.
  const context = await channel.context({
    method: 'post',
    headers: { Authorization: 'Bearer ok', 'X-Forwarded-For': ['1.1.1.1', '2.2.2.2'], skip: undefined },
    input: { message: 'hi' },
  });
  const seen = context.seenRequest;
  check('provider result is the context', context.auth?.uid === 'http-user');
  check('method is uppercased', seen?.method === 'POST');
  check('header names are lowercased', seen?.headers?.authorization === 'Bearer ok');
  check('array header values are joined', seen?.headers?.['x-forwarded-for'] === '1.1.1.1, 2.2.2.2');
  check('undefined headers are dropped', !('skip' in (seen?.headers ?? {})));
  check('input is passed through', seen?.input?.message === 'hi');

  const chat = await channel.context({
    headers: { authorization: 'Bearer ok' },
    input: 'hello',
    channel: { platform: 'slack', user: { id: 'U123' }, tenant: 'T1' },
  });
  check('chat callers reach the provider', chat.auth?.uid === 'U123');
  check('method defaults to POST', chat.seenRequest?.method === 'POST');

  const missing = await rejection(channel.context({ headers: {} }));
  check('no credentials: UNAUTHENTICATED', errorStatus(missing) === 'UNAUTHENTICATED');
  check('UNAUTHENTICATED maps to 401', httpStatusFor(missing) === 401);
  const wrong = await rejection(channel.context({ headers: { authorization: 'Bearer nope' } }));
  check('wrong credentials: PERMISSION_DENIED', errorStatus(wrong) === 'PERMISSION_DENIED');
  check('PERMISSION_DENIED maps to 403', httpStatusFor(wrong) === 403);
  check('isAuthError covers both', isAuthError(missing) && isAuthError(wrong));
  check(
    'other errors are not auth errors',
    !isAuthError(new Error('boom')) && httpStatusFor(new Error('boom')) === 500
  );

  const bad = await rejection(channel.context({ method: 'PATCH' }));
  check('unsupported methods are rejected locally', /Unsupported method "PATCH"/.test(bad?.message ?? ''));

  // The provider runs on the shared box, not a session box, so a refused
  // caller never starts one.
  const shared = (await channel.flow('probe').run({})).result.pid;
  check('route: session runs the provider on the shared box', context.providerPid === shared);
  await channel.agent('echoAgent', { sessionId: 's1', context }).chat({ sessionId: 's1' }).send('hi');
  const snap = await channel.agent('echoAgent', { sessionId: 's1' }).getSnapshot({ sessionId: 's1' });
  check('the agent turn itself ran on its session box', !!snap?.pid && snap.pid !== shared);

  // The context rides along on calls made with it.
  const { result } = await channel.flow('whoami').run({}, { context: { auth: context.auth } });
  check('context reaches the app on the wire', result.context?.auth?.uid === 'http-user');

  await channel.close();
}

/** A provider the app lacks gets a pointer to defineContextProvider. */
async function checkMissingProvider(label, runner) {
  const channel = initChannel({
    config: { expose: { contextProvider: 'nope' }, box: { runner } },
  });
  const e = await rejection(channel.context({ headers: {} }));
  check(
    `[${label}] a missing provider points at defineContextProvider`,
    /no context provider "nope".*defineContextProvider/.test(e?.message ?? '')
  );
  await channel.close();
}

async function exerciseRealApp(label, channel) {
  const context = await channel.context({
    method: 'GET',
    headers: { authorization: 'Bearer ok' },
    channel: { platform: 'discord', user: { id: 'D42' } },
  });
  check(
    `[${label}] defineContextProvider returns the context`,
    context.auth?.uid === 'D42' && context.method === 'GET'
  );

  const missing = await rejection(channel.context({ headers: {} }));
  check(`[${label}] UserFacingError UNAUTHENTICATED survives the hop`, httpStatusFor(missing) === 401);
  check(`[${label}] the provider's message survives`, /sign in first/.test(missing?.message ?? ''));
  const wrong = await rejection(channel.context({ headers: { authorization: 'Bearer x' } }));
  check(`[${label}] UserFacingError PERMISSION_DENIED survives the hop`, httpStatusFor(wrong) === 403);

  const { context: seen } = await channel.flow('whoami')({}, { context });
  check(`[${label}] flows see the provider's context`, seen?.auth?.uid === 'D42');
}

async function realAppExec() {
  const channel = initChannel({
    config: {
      expose: { flows: ['whoami'], contextProvider: 'auth' },
      box: { runner: { type: 'exec', cmd: ['node', echoApp] } },
    },
  });
  await exerciseRealApp('exec', channel);
  const actions = await channel.listActions();
  check(
    'the reserved flow name survives the box (registered and listed)',
    `/flow/${contextProviderFlowName('auth')}` in actions
  );
  await channel.close();
  await checkMissingProvider('exec', { type: 'exec', cmd: ['node', echoApp] });
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

async function realAppRemote() {
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
    process.env.TEST_CONTEXT_SECRET = secret;
    const channel = initChannel({
      config: {
        expose: { flows: ['whoami'], contextProvider: 'auth' },
        box: {
          runner: {
            type: 'remote',
            url: `http://127.0.0.1:${port}`,
            secretEnv: 'TEST_CONTEXT_SECRET',
          },
        },
      },
    });
    await exerciseRealApp('remote', channel);
    await channel.close();
    await checkMissingProvider('remote', {
      type: 'remote',
      url: `http://127.0.0.1:${port}`,
      secretEnv: 'TEST_CONTEXT_SECRET',
    });
  } finally {
    const exited = new Promise((r) => app.once('exit', r));
    app.kill();
    await exited;
  }
}

run('context', async () => {
  await withoutProvider();
  await fakeRuntime();
  await realAppExec();
  await realAppRemote();
});
