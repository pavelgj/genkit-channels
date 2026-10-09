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
 * Smoke test for initChannel over the fake runtime: lazy start, flow
 * run/stream through box proxies, a config file on disk, and that the
 * channel never calls listActions on its own. Run after `pnpm build`:
 *
 *   node test/smoke.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initChannel } from '../dist/index.js';
import { check, fakeRuntimeCmd, run } from './helpers.mjs';

run('smoke', async () => {
  // A config file, like the one the CLI writes into the staging dir. The
  // runner cwd is relative to the file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-smoke-'));
  const configPath = path.join(dir, 'channel.config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      expose: { flows: ['echo', 'probe'] },
      options: { greeting: 'hi' },
      box: { runner: { type: 'exec', cmd: fakeRuntimeCmd, cwd: '.' } },
    })
  );

  const channel = initChannel({ configPath });
  check('expose comes from config', channel.expose.flows.includes('echo'));
  check('options come from config', channel.options.greeting === 'hi');

  // Creating a proxy starts nothing; the first call does.
  const echo = channel.flow('echo');
  const res = await echo.run({ hello: 'world' });
  check(
    'flow run echoes input',
    JSON.stringify(res.result.echoed) === JSON.stringify({ hello: 'world' })
  );
  check('flow run reports a trace id', !!res.telemetry?.traceId);

  const { stream, output } = echo.stream({ q: 'stream?' });
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  check('flow stream produced chunks', chunks.length === 3);
  check('flow stream returns the result', (await output).action === '/flow/echo');

  const probe = await channel.flow('probe').run({});
  check('channel never called listActions', probe.result.listActionsCalls === 0);

  // Explicit, opt-in discovery still works.
  const actions = await channel.listActions();
  check('listActions (opt-in) returns actions', !!actions['/flow/echo']);

  await channel.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
