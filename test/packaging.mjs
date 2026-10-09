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
 * Renders the packaging artifacts (Dockerfiles) for every user runtime
 * (js|go|python), for both packagings, and asserts a few invariants. This is a fast, container-free check
 * that the shared packaging helpers produce coherent Dockerfiles after the
 * refactor. Run after `pnpm build`:
 *
 *   node test/packaging.mjs
 */

import { resolveChannelBuildPlan } from '../dist/core/channels/build-plan.js';
import { renderSingleContainerDockerfile } from '../dist/core/packaging/single-container.js';
import {
  renderChannelDockerfile,
  renderUserDockerfile,
} from '../dist/core/packaging/sidecar.js';
import { getRuntimeBuilder } from '../dist/core/runtimes/index.js';
import { renderServiceYaml } from '../dist/core/targets/cloud-run.js';

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
}

function fakeChannelDef() {
  return {
    name: 'http',
    language: 'node',
    entry: 'src/index.js',
    dir: '/tmp/http',
  };
}

function fakePlan(userLang) {
  const runtime = getRuntimeBuilder(userLang).resolve({ language: userLang });
  const def = fakeChannelDef();
  return {
    stagingDir: '/tmp/staging',
    runtime,
    channel: {
      definition: def,
      entryFromStaging: `channel/${def.entry}`,
      build: resolveChannelBuildPlan(def),
    },
    expose: { agents: [], flows: [] },
    config: {},
    env: [],
    writeChannelConfig() {},
    channelConfig: {},
    channelConfigFor: () => ({}),
  };
}

const userLangs = ['js', 'go', 'python'];

for (const ul of userLangs) {
  const plan = fakePlan(ul);
  const single = renderSingleContainerDockerfile(plan);

  check(`[single ${ul}] has a final runtime stage`, single.includes('AS runtime'));
  check(`[single ${ul}] copies channel.config.json`, single.includes('channel.config.json'));
  check(`[single ${ul}] installs channel npm deps`, single.includes('npm install'));
  check(`[single ${ul}] CMD runs node entry`, single.includes('/app/channel/src/index.js'));
  if (ul === 'python') {
    check(`[single ${ul}] installs python runtime on node base`, single.includes('python3'));
  }

  const chDf = renderChannelDockerfile(plan);
  const usDf = renderUserDockerfile(plan);
  check(`[sidecar ${ul}] channel image has no user copy`, !chDf.includes('COPY user/'));
  check(`[sidecar ${ul}] user image has no channel copy`, !usDf.includes('COPY channel/'));
  check(`[sidecar ${ul}] channel image exposes ingress`, chDf.includes('EXPOSE 8080'));
}

// A Node channel that declares a `build` (e.g. a TypeScript channel) must use
// that build command in its plan and run its compiled entry, instead of the
// default `npm install --omit=dev`.
{
  const tsDef = {
    name: 'http-ts',
    language: 'node',
    entry: 'dist/index.js',
    build: 'npm install && npm run build',
    dir: '/tmp/http-ts',
  };
  const plan = resolveChannelBuildPlan(tsDef);
  check(
    '[node-build] uses the declared build command',
    plan.buildSteps.some((s) => s.includes('npm run build'))
  );
  check(
    '[node-build] does not fall back to npm install --omit=dev',
    !plan.buildSteps.some((s) => s.includes('--omit=dev'))
  );
  check(
    '[node-build] runs the compiled entry',
    plan.runCommand.join(' ').includes('/app/channel/dist/index.js')
  );
}

// Cloud Run sidecar: the app serves reflection on loopback (no dev mode), and
// both containers share the reflection secret.
{
  const yaml = renderServiceYaml({
    service: 'svc',
    channelImage: 'img/channel',
    userImage: 'img/app',
    reflectionSecret: 's3cret',
    userEnv: [],
    settings: { access: 'private', cpu: 'request-only' },
  });
  check('[sidecar yaml] enables reflection without dev mode', yaml.includes('GENKIT_REFLECTION_ENABLED') && !yaml.includes('GENKIT_ENV'));
  check('[sidecar yaml] pins the reflection port', yaml.includes('GENKIT_REFLECTION_PORT'));
  check(
    '[sidecar yaml] both containers get the secret',
    yaml.split('GENKIT_REFLECTION_SECRET_TOKEN').length - 1 === 2
  );
  check('[sidecar yaml] app no longer dials the channel', !yaml.includes('GENKIT_REFLECTION_V2_SERVER'));
}

if (failures > 0) {
  console.error(`\n${failures} packaging check(s) failed.`);
  process.exit(1);
}
console.log('\nAll packaging checks passed.');

