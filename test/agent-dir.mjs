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
 * End-to-end test of the agent-dir feature. Spawns the built-in agent-dir
 * runtime (loadAgentDir over a temp agents folder) as a child via
 * startAppProcess, discovers the agent over reflection v2, and drives a real
 * turn through the ergonomic AgentAPI, exactly as an agent channel (Discord)
 * would.
 *
 * Requires a model API key (GEMINI_API_KEY / GOOGLE_API_KEY). When none is set,
 * the live-turn assertions are skipped but discovery is still checked. Run after
 * `pnpm build`:
 *
 *   . ~/init-gemini.sh && node test/agent-dir.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAppProcess } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
}

/** Writes a minimal agents/ folder with one prompt-only agent + a skill. */
function makeAgentsDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dir-test-'));
  const agentDir = path.join(root, 'agents', 'helper');
  fs.mkdirSync(path.join(agentDir, 'skills', 'greeting'), { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'agent.prompt'),
    `---\nconfig:\n  temperature: 0\nuse:\n  - skills\n---\n\n` +
      `{{role "system"}}\nYou are a terse assistant. Answer in one short sentence.\n`
  );
  fs.writeFileSync(
    path.join(agentDir, 'skills', 'greeting', 'SKILL.md'),
    `---\nname: greeting\ndescription: A friendly greeting.\n---\n\nSay hello warmly.\n`
  );
  return root;
}

/** The tiny headless runtime: loads the agents dir, then idles. */
function makeRuntimeEntry(projectRoot) {
  const entry = path.join(projectRoot, 'runtime.mjs');
  fs.writeFileSync(
    entry,
    `import { loadAgentDir } from '${repoRoot}/dist/agent-dir/index.js';\n` +
      `loadAgentDir({ dir: '${path.join(projectRoot, 'agents')}' });\n` +
      `setInterval(() => {}, 1 << 30);\n`
  );
  return entry;
}

async function main() {
  const projectRoot = makeAgentsDir();
  const entry = makeRuntimeEntry(projectRoot);

  const app = startAppProcess({
    child: { command: 'node', args: [entry], cwd: projectRoot },
    readyTimeoutMs: 30000,
  });
  await app.ready;

  const agents = await app.listAgents();
  const helper = agents.find((a) => a.name === 'helper');
  check('agent-dir registers /agent/helper', !!helper);

  const hasKey = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  if (!hasKey && helper) {
    console.log('  skip live turn (no GEMINI_API_KEY / GOOGLE_API_KEY set)');
  } else if (helper) {
    const agent = await app.getAgent(helper.key);
    // Dir agents have no store by default (client-managed state), so open a
    // stateless chat rather than passing a sessionId.
    const chat = agent.chat();
    const turn = chat.sendStream('Say hi in five words.');

    let streamed = '';
    for await (const chunk of turn.stream) {
      if (chunk.text) streamed += chunk.text;
    }
    const res = await turn.response;
    check('live turn returns text', !!(res.text && res.text.length > 0));
  }

  await app.stop();
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll agent-dir checks passed.');
  process.exit(0);
}

main().catch((e) => {
  console.error('agent-dir test crashed:', e);
  process.exit(1);
});
