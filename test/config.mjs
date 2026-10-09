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
 * Config schema + the CLI compile step (a channels.yaml deployment ->
 * channel.config.json). No processes. Run after `pnpm build`:
 *
 *   node test/config.mjs
 */

import { buildChannelConfig } from '../dist/core/channel-config.js';
import { durationMs, parseChannelConfig } from '../dist/lib/config.js';
import { inheritEnvFor } from '../dist/lib/runner.js';
import { check, run } from './helpers.mjs';

function parsing() {
  const parsed = parseChannelConfig({ expose: { agents: ['a'] } });
  check('defaults fill expose.flows', Array.isArray(parsed.expose.flows));
  check('defaults fill box', typeof parsed.box === 'object');

  let error = '';
  try {
    parseChannelConfig({ box: { runner: { type: 'exec', isolate: 'chroot' } } });
  } catch (e) {
    error = e.message;
  }
  check('invalid isolate is rejected with its path', error.includes('box.runner.isolate'));

  error = '';
  try {
    parseChannelConfig({ box: { route: 'app', idel: '5m' } });
  } catch (e) {
    error = e.message;
  }
  check('unknown box keys are rejected (typo guard)', error.includes('idel'));

  check('durations parse', durationMs('10m') === 600_000 && durationMs(250) === 250);
}

const runtime = { language: 'js', command: 'node', args: ['lib/index.js'], cwd: 'app' };

function compile() {
  const compiled = buildChannelConfig({
    deployment: {
      name: 'bot',
      channel: 'discord',
      expose: { agent: 'concierge', agentState: { concierge: 'client' } },
      box: {
        route: 'session',
        env: ['GEMINI_API_KEY'],
        runner: { type: 'exec', isolate: 'local' },
      },
      with: { session: 'thread' },
    },
    runtime,
    expose: { agents: ['concierge'], flows: [] },
    channelEnv: ['DISCORD_TOKEN'],
    appDir: 'user',
  });
  const runner = compiled.box.runner;
  check(
    'runner cmd defaults to the runtime command',
    JSON.stringify(runner.cmd) === '["node","lib/index.js"]'
  );
  check('runner cwd points at the app', runner.cwd === 'user/app');
  check('user runner fields are kept', runner.isolate === 'local');
  check('channel env is denied to the box', compiled.box.denyEnv?.includes('DISCORD_TOKEN'));
  check('route is kept', compiled.box.route === 'session');
  check('agentState is carried over', compiled.agentState.concierge === 'client');
  check('with becomes options', compiled.options.session === 'thread');

  const allowed = buildChannelConfig({
    deployment: { name: 'x', channel: 'discord', box: { env: ['DISCORD_TOKEN'] } },
    runtime,
    expose: { agents: [], flows: [] },
    channelEnv: ['DISCORD_TOKEN'],
    appDir: 'user',
  });
  check('an explicit box.env allow wins over the channel deny', !allowed.box.denyEnv);

  const remote = buildChannelConfig({
    deployment: {
      name: 'x',
      channel: 'http',
      box: { runner: { type: 'remote', url: 'http://127.0.0.1:3100' } },
    },
    runtime,
    expose: { agents: [], flows: ['f'] },
    channelEnv: [],
    appDir: 'user',
  });
  check('remote runner is left as written', !('cmd' in remote.box.runner));
  check('compiled config validates', !!parseChannelConfig(compiled));
}

function envPolicy() {
  const env = { A: '1', B: '2', SECRET: 'x' };
  check('no policy inherits everything', inheritEnvFor({}, env) === true);
  check(
    'denyEnv becomes an allowlist of the rest',
    JSON.stringify(inheritEnvFor({ denyEnv: ['SECRET'] }, env)) === '["A","B"]'
  );
  check(
    'env allowlist minus denied',
    JSON.stringify(inheritEnvFor({ env: ['A', 'SECRET'], denyEnv: ['SECRET'] }, env)) ===
      '["A"]'
  );
}

run('config', async () => {
  parsing();
  compile();
  envPolicy();
});
