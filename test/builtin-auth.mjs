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
 * Built-in context providers (`expose.contextProvider: { apiKey: ... }`):
 *  - the check itself, run in the channel without starting the app,
 *  - channels.yaml parsing,
 *  - compose turning the keys into channel secrets (denied to the app),
 *  - the Slack/Discord rules that refuse it.
 * Run after `pnpm build`:
 *
 *   node test/builtin-auth.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compose } from '../dist/core/compose.js';
import { loadChannel } from '../dist/core/channels/loader.js';
import { validateChannelConfig } from '../dist/core/channels/validate.js';
import { loadManifest } from '../dist/core/manifest.js';
import { httpStatusFor, initChannel } from '../dist/index.js';
import { check, run } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoChannels = path.join(here, '..', 'channels');

async function rejection(p) {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

async function runtimeCheck() {
  process.env.TEST_KEY_OLD = 'old-key';
  process.env.TEST_KEY_NEW = 'new-key';
  const channel = initChannel({
    config: {
      expose: {
        agents: ['a'],
        contextProvider: { apiKey: { secrets: ['TEST_KEY_OLD', 'TEST_KEY_NEW'] } },
      },
      // `false` exits at once: any call that reached the app would fail.
      box: { runner: { type: 'exec', cmd: ['false'] } },
    },
  });

  const missing = await rejection(channel.context({ headers: {} }));
  check('no header: 401', httpStatusFor(missing) === 401);
  const blank = await rejection(channel.context({ headers: { authorization: 'Bearer ' } }));
  check('an empty bearer counts as missing', httpStatusFor(blank) === 401);
  const wrong = await rejection(channel.context({ headers: { Authorization: 'Bearer nope' } }));
  check('wrong key: 403', httpStatusFor(wrong) === 403);
  const prefix = await rejection(channel.context({ headers: { authorization: 'new-key-and-more' } }));
  check('a key with extra characters is refused', httpStatusFor(prefix) === 403);

  const viaBearer = await channel.context({ headers: { Authorization: 'Bearer new-key' } });
  check('the new key passes with Bearer', viaBearer.auth?.keyName === 'TEST_KEY_NEW');
  const bare = await channel.context({ headers: { authorization: 'old-key' } });
  check('the old key passes without Bearer (rotation)', bare.auth?.keyName === 'TEST_KEY_OLD');
  check('context names the provider', bare.auth?.provider === 'apiKey');
  check('context never carries the key', !JSON.stringify(bare).includes('old-key'));
  await channel.close();

  delete process.env.TEST_KEY_OLD;
  let startupError = '';
  try {
    initChannel({
      config: {
        expose: { contextProvider: { apiKey: { secrets: ['TEST_KEY_OLD'] } } },
        box: { runner: { type: 'exec', cmd: ['false'] } },
      },
    });
  } catch (e) {
    startupError = e.message;
  }
  check('a missing key fails at startup', /Missing secrets: TEST_KEY_OLD/.test(startupError));
}

function writeManifest(projectDir, expose, extra = '') {
  fs.writeFileSync(
    path.join(projectDir, 'channels.yaml'),
    'deployments:\n  - name: api\n    channel: http\n    expose:\n' +
      '      agent: assistant\n' +
      expose +
      extra
  );
}

function manifestError(projectDir, expose) {
  writeManifest(projectDir, expose);
  try {
    loadManifest(projectDir);
    return '';
  } catch (e) {
    return e.message;
  }
}

const BOTH_KEYS = '      contextProvider:\n        apiKey: { secrets: [API_KEY, API_KEY_NEXT] }\n';

function parsing(projectDir) {
  writeManifest(projectDir, BOTH_KEYS);
  const builtin = loadManifest(projectDir).deployments[0].expose.contextProvider;
  check(
    'a built-in parses',
    JSON.stringify(builtin) === '{"apiKey":{"secrets":["API_KEY","API_KEY_NEXT"]}}'
  );

  writeManifest(projectDir, '      contextProvider: auth\n');
  check(
    'a provider name still parses',
    loadManifest(projectDir).deployments[0].expose.contextProvider === 'auth'
  );

  const rejected = (yaml) =>
    /contextProvider/.test(manifestError(projectDir, `      contextProvider:\n        ${yaml}\n`));
  check('a misspelled built-in is rejected', rejected('apiKye: { secrets: [K] }'));
  check('an empty secrets list is rejected', rejected('apiKey: { secrets: [] }'));
  check('a secret must be an env var name', rejected('apiKey: { secrets: [my-key] }'));
}

async function composing(projectDir) {
  writeManifest(
    projectDir,
    BOTH_KEYS,
    '    secrets:\n      GEMINI_API_KEY: ~\n      API_KEY: shared-key@3\n'
  );
  const [deployment] = loadManifest(projectDir).deployments;
  const plan = await compose(projectDir, deployment);
  const byName = Object.fromEntries(plan.secrets.map((s) => [s.name, s]));
  check(
    'the keys are channel secrets',
    byName.API_KEY?.consumer === 'channel' && byName.API_KEY_NEXT?.consumer === 'channel'
  );
  check('a key keeps its platform rename', byName.API_KEY?.ref === 'shared-key@3');
  check("app secrets stay the app's", byName.GEMINI_API_KEY?.consumer === 'app');
  const config = plan.channelConfig;
  check(
    'the channel checks the keys at startup',
    config.secrets.includes('API_KEY') && config.secrets.includes('API_KEY_NEXT')
  );
  check(
    'the box is denied the keys',
    config.box.denyEnv?.includes('API_KEY') && config.box.denyEnv?.includes('API_KEY_NEXT')
  );
  check(
    'the built-in is compiled in',
    config.expose.contextProvider?.apiKey?.secrets.length === 2
  );
}

async function chatChannelsRefuse(projectDir) {
  for (const name of ['slack-socket', 'discord']) {
    const def = loadChannel(projectDir, name);
    const ctx = (contextProvider) => ({
      deployment: { name: 'bot', channel: name },
      expose: { agents: ['a'], flows: [], contextProvider },
      config: {},
      env: [],
      child: { command: 'node', args: [], cwd: '.' },
    });
    const refused = await rejection(
      validateChannelConfig(def, ctx({ apiKey: { secrets: ['K'] } }))
    );
    check(
      `[${name}] the built-in apiKey is refused`,
      /needs HTTP headers/.test(refused?.message ?? '')
    );
    const allowed = await rejection(validateChannelConfig(def, ctx('auth')));
    check(`[${name}] an app-defined provider is fine`, allowed === undefined);
  }
}

run('builtin-auth', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-builtin-auth-'));
  try {
    // "Installed" channels: links to the repo's sources.
    const installed = path.join(projectDir, '.genkit', 'channels');
    fs.mkdirSync(installed, { recursive: true });
    for (const name of ['http', 'slack-socket', 'discord']) {
      fs.symlinkSync(path.join(repoChannels, name), path.join(installed, name));
    }
    await runtimeCheck();
    parsing(projectDir);
    await composing(projectDir);
    await chatChannelsRefuse(projectDir);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

