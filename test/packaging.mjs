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
 * Renders the packaging artifacts (Dockerfiles) for every combination of
 * channel language (node|go) and user runtime (js|go|python), for both
 * packagings, and asserts a few invariants. This is a fast, container-free check
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

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
}

function fakeChannelDef(language) {
  return language === 'go'
    ? {
        name: 'http-go',
        language: 'go',
        entry: 'bin/app',
        build: 'go build -o bin/app .',
        dir: '/tmp/http-go',
      }
    : {
        name: 'http',
        language: 'node',
        entry: 'src/index.js',
        dir: '/tmp/http',
      };
}

function fakePlan(channelLang, userLang) {
  const runtime = getRuntimeBuilder(userLang).resolve({ language: userLang });
  const def = fakeChannelDef(channelLang);
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
    managedConfig: {},
  };
}

const channelLangs = ['node', 'go'];
const userLangs = ['js', 'go', 'python'];

for (const cl of channelLangs) {
  for (const ul of userLangs) {
    const plan = fakePlan(cl, ul);
    const single = renderSingleContainerDockerfile(plan);

    check(`[single ${cl}/${ul}] has a final runtime stage`, single.includes('AS runtime'));
    check(`[single ${cl}/${ul}] copies channel.config.json`, single.includes('channel.config.json'));
    if (cl === 'go') {
      check(`[single ${cl}/${ul}] builds the channel binary`, single.includes('AS channelbuild'));
      check(`[single ${cl}/${ul}] CMD runs the channel binary`, single.includes('/app/channel/bin/app'));
    } else {
      check(`[single ${cl}/${ul}] installs channel npm deps`, single.includes('npm install'));
      check(`[single ${cl}/${ul}] CMD runs node entry`, single.includes('/app/channel/src/index.js'));
    }
    if (ul === 'python' && cl === 'node') {
      check(`[single ${cl}/${ul}] installs python runtime on node base`, single.includes('python3'));
    }

    const chDf = renderChannelDockerfile(plan);
    const usDf = renderUserDockerfile(plan);
    check(`[sidecar ${cl}/${ul}] channel image has no user copy`, !chDf.includes('COPY user/'));
    check(`[sidecar ${cl}/${ul}] user image has no channel copy`, !usDf.includes('COPY channel/'));
    check(`[sidecar ${cl}/${ul}] channel image exposes ingress`, chDf.includes('EXPOSE 8080'));
  }
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

if (failures > 0) {
  console.error(`\n${failures} packaging check(s) failed.`);
  process.exit(1);
}
console.log('\nAll packaging checks passed.');

