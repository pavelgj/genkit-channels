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
 * Secrets: .env loading, channel/app routing, Secret Manager references, the
 * deploy-time existence check (with a stubbed gcloud), and the library's
 * startup check. Run after `pnpm build`:
 *
 *   node test/secrets.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initChannel } from '../dist/index.js';
import { loadDotenv, missingSecrets, resolveSecrets } from '../dist/core/secrets.js';
import {
  checkGcpSecrets,
  parseGcpSecretRef,
  setSecretsFlag,
} from '../dist/core/targets/gcp-secrets.js';
import { renderServiceYaml } from '../dist/core/targets/cloud-run.js';
import { check, run } from './helpers.mjs';

function dotenv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-dotenv-'));
  fs.writeFileSync(path.join(dir, '.env'), 'A=env\nB=env\nC=env\nD=env\nE=env\n');
  fs.writeFileSync(path.join(dir, '.env.local'), 'B=local\nC=local\nD=local\n');
  fs.writeFileSync(path.join(dir, '.env.bot'), 'C=bot\nD=bot\n');
  fs.writeFileSync(path.join(dir, '.env.bot.local'), 'D=bot-local\n# comment\nQ="quoted value"\n');
  const { values, files } = loadDotenv(dir, 'bot', { E: 'shell' });
  check('.env is the base', values.A === 'env');
  check('.env.local beats .env', values.B === 'local');
  check('.env.<deployment> beats .env.local', values.C === 'bot');
  check('.env.<deployment>.local wins over all files', values.D === 'bot-local');
  check('the shell wins over every file', !('E' in values));
  check('quoted values are unquoted', values.Q === 'quoted value');
  check('reports which files were read', files.length === 4);
  const other = loadDotenv(dir, 'other', {});
  check('other deployments skip .env.bot*', other.values.D === 'local');
  fs.rmSync(dir, { recursive: true, force: true });
}

function routing() {
  const list = resolveSecrets({
    channelName: 'discord',
    channelSecrets: ['DISCORD_TOKEN'],
    deploymentSecrets: ['GEMINI_API_KEY'],
  });
  check('channel secrets go to the channel', list[0].name === 'DISCORD_TOKEN' && list[0].consumer === 'channel');
  check('deployment secrets go to the app', list[1].name === 'GEMINI_API_KEY' && list[1].consumer === 'app');
  check('ref defaults to the name', list[1].ref === 'GEMINI_API_KEY');

  const mapped = resolveSecrets({
    channelName: 'discord',
    channelSecrets: ['DISCORD_TOKEN'],
    deploymentSecrets: { DISCORD_TOKEN: 'discord-token@2', GEMINI_API_KEY: null },
  });
  check(
    'a map entry for a channel secret only remaps it',
    mapped.length === 2 && mapped[0].consumer === 'channel' && mapped[0].ref === 'discord-token@2'
  );
  check('a null map value means same name', mapped[1].ref === 'GEMINI_API_KEY');

  const missing = missingSecrets(list, { DISCORD_TOKEN: 'x', GEMINI_API_KEY: '' });
  check('empty values count as missing', missing.length === 1 && missing[0].name === 'GEMINI_API_KEY');
}

function refs() {
  check('NAME', JSON.stringify(parseGcpSecretRef('KEY')) === '{"secret":"KEY","version":"latest"}');
  check('NAME@VERSION', parseGcpSecretRef('my-key@3').version === '3');
  const full = parseGcpSecretRef('projects/shared/secrets/key/versions/7');
  check('full resource name', full.project === 'shared' && full.secret === 'key' && full.version === '7');
  let threw = false;
  try {
    parseGcpSecretRef('bad name!');
  } catch {
    threw = true;
  }
  check('bad refs are rejected', threw);

  const secrets = resolveSecrets({
    channelName: 'discord',
    channelSecrets: ['DISCORD_TOKEN'],
    deploymentSecrets: { GEMINI_API_KEY: 'projects/shared/secrets/gemini' },
  });
  check(
    '--set-secrets flag',
    setSecretsFlag(secrets) ===
      'DISCORD_TOKEN=DISCORD_TOKEN:latest,GEMINI_API_KEY=projects/shared/secrets/gemini:latest'
  );

  const yaml = renderServiceYaml({
    service: 'svc',
    channelImage: 'img/channel',
    userImage: 'img/app',
    reflectionSecret: 'tok',
    userEnv: [],
    secrets,
    settings: { access: 'private', cpu: 'request-only' },
  });
  const [channelPart, appPart] = yaml.split('- name: app');
  check('[sidecar] channel container gets its secret', channelPart.includes('name: DISCORD_TOKEN') && channelPart.includes('secretKeyRef'));
  check('[sidecar] channel container does not get app secrets', !channelPart.includes('GEMINI_API_KEY'));
  check('[sidecar] app container gets its secret', appPart.includes('name: GEMINI_API_KEY'));
  check('[sidecar] app container does not get channel secrets', !appPart.includes('DISCORD_TOKEN'));
  check(
    '[sidecar] other-project secrets are aliased',
    yaml.includes('run.googleapis.com/secrets: "secret-0:projects/shared/secrets/gemini"') &&
      appPart.includes('name: "secret-0"')
  );
}

function gcpCheck() {
  const secrets = resolveSecrets({
    channelName: 'discord',
    channelSecrets: ['DISCORD_TOKEN'],
    deploymentSecrets: ['GEMINI_API_KEY'],
  });
  const calls = [];
  const fakeGcloud = (existing) => (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'config') return 'my-prj';
    if (args[0] === 'projects') return '12345';
    if (args[0] === 'secrets' && args[1] === 'describe') {
      return existing.includes(args[2]) ? `projects/my-prj/secrets/${args[2]}` : undefined;
    }
    return undefined;
  };
  const attempt = (gcloud) => {
    try {
      checkGcpSecrets(secrets, gcloud);
      return undefined;
    } catch (e) {
      return e;
    }
  };

  check('all present: passes', !attempt(fakeGcloud(['DISCORD_TOKEN', 'GEMINI_API_KEY'])));
  check(
    'only reads (describe), never creates',
    calls.every((c) => !/secrets create|versions add|add-iam/.test(c))
  );

  const msg = attempt(fakeGcloud(['DISCORD_TOKEN']))?.message ?? '';
  check('missing: fails', msg !== '');
  check(
    'missing: names only the missing secret and who needs it',
    msg.includes('GEMINI_API_KEY  (app)') && !msg.includes('DISCORD_TOKEN')
  );
  check(
    'missing: prints the create command',
    msg.includes('gcloud secrets create GEMINI_API_KEY --data-file=- --project=my-prj')
  );
  check(
    'missing: prints the access grant',
    msg.includes('12345-compute@developer.gserviceaccount.com') &&
      msg.includes('roles/secretmanager.secretAccessor')
  );
  check(
    'no project: says how to set one',
    /gcloud config set project/.test(attempt(() => undefined)?.message ?? '')
  );
}

async function library() {
  const config = {
    secrets: ['TEST_CHANNEL_SECRET'],
    box: { runner: { type: 'exec', cmd: 'true' } },
  };
  delete process.env.TEST_CHANNEL_SECRET;
  let error;
  try {
    initChannel({ config });
  } catch (e) {
    error = e;
  }
  check('initChannel fails fast on a missing declared secret', /TEST_CHANNEL_SECRET/.test(error?.message ?? ''));

  process.env.TEST_CHANNEL_SECRET = 'v';
  const channel = initChannel({ config });
  check('channel.secret() reads it', channel.secret('TEST_CHANNEL_SECRET') === 'v');
  let undeclared;
  try {
    channel.secret('NOPE_NOT_SET');
  } catch (e) {
    undeclared = e;
  }
  check('channel.secret() points at channel.yaml for undeclared names', /channel\.yaml/.test(undeclared?.message ?? ''));
  delete process.env.TEST_CHANNEL_SECRET;
  await channel.close();
}

run('secrets', async () => {
  dotenv();
  routing();
  refs();
  gcpCheck();
  await library();
});
