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
 * Live test against Gemini, using the discord-agent sample app as written
 * (its channels.yaml compiled the way `deploy --local` does), with one box
 * per conversation. Checks a tool-calling agent, streaming, per-session boxes
 * resumed by snapshotId, and that the channel's secret stays out of the box.
 *
 * Needs GEMINI_API_KEY and the sample built once:
 *
 *   (cd samples/discord-agent && npm install && npm run build)
 *   . ~/init-gemini.sh && node test/live.mjs
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChannelConfig } from '../dist/core/channel-config.js';
import { loadManifest } from '../dist/core/manifest.js';
import { getRuntimeBuilder } from '../dist/core/runtimes/index.js';
import { initChannel } from '../dist/index.js';
import { check, run } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sampleDir = path.resolve(here, '..', 'samples', 'discord-agent');

if (!process.env.GEMINI_API_KEY) {
  console.log('skip: GEMINI_API_KEY is not set');
  process.exit(0);
}
if (!fs.existsSync(path.join(sampleDir, 'lib', 'index.js'))) {
  console.log('skip: build samples/discord-agent first (npm install && npm run build)');
  process.exit(0);
}

/** Tool names requested anywhere in a message history. */
function toolCalls(messages = []) {
  return messages
    .flatMap((m) => m.content)
    .filter((p) => p.toolRequest)
    .map((p) => p.toolRequest.name);
}

run('live', async () => {
  const [deployment] = loadManifest(sampleDir).deployments;
  deployment.box = { ...deployment.box, route: 'session', idle: '1m' };
  const config = buildChannelConfig({
    deployment,
    runtime: getRuntimeBuilder('js').resolve(deployment.runtime),
    expose: { agents: [deployment.expose.agent], flows: [] },
    channelEnv: ['DISCORD_TOKEN'],
    appDir: sampleDir,
  });
  check('the channel secret is denied to the box', config.box.denyEnv?.includes('DISCORD_TOKEN'));

  process.env.DISCORD_TOKEN = 'channel-secret';
  const channel = initChannel({ config });
  const agent = channel.agent();

  const tokyo = agent.chat({ sessionId: randomUUID() });
  const turn = tokyo.sendStream("What's the weather in Tokyo? One sentence.");
  let streamed = '';
  for await (const chunk of turn.stream) streamed += chunk.text;
  const t1 = await turn.response;
  console.log(`  tokyo: ${t1.text.trim()}`);
  check('turn streams text', streamed.length > 0);
  check('turn finishes', t1.finishReason === 'stop');

  const paris = agent.chat({ sessionId: randomUUID() });
  const p1 = await paris.send('And the weather in Paris? One sentence.');
  console.log(`  paris: ${p1.text.trim()}`);

  // Second turns resume by snapshotId only, so each must find its own box.
  const t2 = await tokyo.send('Which city did I ask about? Answer with just the city.');
  const p2 = await paris.send('Which city did I ask about? Answer with just the city.');
  check('tokyo conversation remembered (own box)', /tokyo/i.test(t2.text));
  check('paris conversation remembered (own box)', /paris/i.test(p2.text));

  const snap = await agent.getSnapshot({ sessionId: tokyo.sessionId });
  check('snapshot holds the tokyo history', (snap?.state?.messages?.length ?? 0) >= 4);
  // The turn's response only carries the final message; the tool round trip
  // lives in the session history.
  check('agent called its tool', toolCalls(snap?.state?.messages).includes('getWeather'));

  await channel.close();
});
