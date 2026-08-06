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
 * Unit tests for service settings resolution + validation, and their Cloud Run
 * translation. Container-free; run after `pnpm build`:
 *
 *   node test/service-settings.mjs
 */

import assert from 'node:assert';
import {
  parseServiceSettings,
  resolveServiceSettings,
} from '../dist/core/service-settings.js';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.error(`  FAIL ${name}: ${e.message}`);
  }
}

// --- resolution precedence -------------------------------------------------

check('defaults are private + request-only', () => {
  const { settings } = resolveServiceSettings(undefined, undefined);
  assert.equal(settings.access, 'private');
  assert.equal(settings.cpu, 'request-only');
  assert.equal(settings.minInstances, undefined);
});

check('user value wins over channel recommendation', () => {
  const { settings } = resolveServiceSettings(
    { cpu: 'request-only' },
    { cpu: 'always-allocated' }
  );
  assert.equal(settings.cpu, 'request-only');
});

check('channel recommendation applies as a default (non-access)', () => {
  const { settings } = resolveServiceSettings(undefined, {
    cpu: 'always-allocated',
    minInstances: 1,
  });
  assert.equal(settings.cpu, 'always-allocated');
  assert.equal(settings.minInstances, 1);
});

// --- the auth-never-escalates rule -----------------------------------------

check('channel public recommendation does NOT auto-apply', () => {
  const { settings, notices } = resolveServiceSettings(undefined, {
    access: 'public',
  });
  assert.equal(settings.access, 'private');
  assert.ok(
    notices.some((n) => n.includes('public')),
    'expected an opt-in notice'
  );
});

check('user public opt-in applies', () => {
  const { settings } = resolveServiceSettings(
    { access: 'public' },
    { access: 'public' }
  );
  assert.equal(settings.access, 'public');
});

check('channel private recommendation applies normally', () => {
  const { settings } = resolveServiceSettings(undefined, { access: 'private' });
  assert.equal(settings.access, 'private');
});

// --- cost notices ----------------------------------------------------------

check('always-allocated cpu emits a cost notice', () => {
  const { notices } = resolveServiceSettings({ cpu: 'always-allocated' }, undefined);
  assert.ok(notices.some((n) => n.toLowerCase().includes('idle')));
});

check('minInstances >= 1 emits a warm-instance notice', () => {
  const { notices } = resolveServiceSettings({ minInstances: 2 }, undefined);
  assert.ok(notices.some((n) => n.includes('warm')));
});

check('minInstances 0 emits no warm-instance notice', () => {
  const { notices } = resolveServiceSettings({ minInstances: 0 }, undefined);
  assert.ok(!notices.some((n) => n.includes('warm')));
});

// --- validation ------------------------------------------------------------

check('parseServiceSettings rejects bad access', () => {
  assert.throws(() => parseServiceSettings({ access: 'open' }, 's'));
});

check('parseServiceSettings rejects bad cpu', () => {
  assert.throws(() => parseServiceSettings({ cpu: 'turbo' }, 's'));
});

check('parseServiceSettings rejects negative minInstances', () => {
  assert.throws(() => parseServiceSettings({ minInstances: -1 }, 's'));
});

check('parseServiceSettings rejects non-integer concurrency', () => {
  assert.throws(() => parseServiceSettings({ concurrency: 1.5 }, 's'));
});

check('parseServiceSettings accepts a full valid block', () => {
  const s = parseServiceSettings(
    {
      access: 'public',
      cpu: 'always-allocated',
      minInstances: 1,
      maxInstances: 5,
      concurrency: 80,
      memory: '512Mi',
    },
    's'
  );
  assert.equal(s.access, 'public');
  assert.equal(s.memory, '512Mi');
});

check('parseServiceSettings returns undefined for undefined input', () => {
  assert.equal(parseServiceSettings(undefined, 's'), undefined);
});

if (failures > 0) {
  console.error(`\n${failures} service-settings check(s) failed.`);
  process.exit(1);
}
console.log('\nAll service-settings checks passed.');
