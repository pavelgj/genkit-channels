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
 * Built-in context providers: configured in channels.yaml, run in the channel
 * process. A refused caller never reaches the box, and the provider's secrets
 * stay in the channel (compose declares them as channel secrets, which the
 * box config denies to the app).
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { UserFacingError, type ActionContext } from 'genkit';
import type { ChannelRequest } from './channel-request';
import type {
  ApiKeyProviderConfig,
  BuiltinContextProvider,
  ContextProviderConfig,
} from './config';

/** What a built-in provider puts in `context.auth`. */
export interface BuiltinAuthContext extends ActionContext {
  auth: {
    provider: 'apiKey';
    /** Which secret matched (its name, never its value); handy mid-rotation. */
    keyName: string;
  };
}

/**
 * Runs a built-in provider. Throws `UserFacingError` UNAUTHENTICATED (no
 * credentials) or PERMISSION_DENIED (wrong ones), like genkit's `apiKey()`.
 */
export function runBuiltinContextProvider(
  config: BuiltinContextProvider,
  request: ChannelRequest,
  env: NodeJS.ProcessEnv = process.env
): BuiltinAuthContext {
  return checkApiKey(config.apiKey, request, env);
}

/** Secrets a provider needs in the channel process (none for app-defined). */
export function contextProviderSecrets(
  config: ContextProviderConfig | undefined
): string[] {
  if (config === undefined || typeof config === 'string') return [];
  return [...config.apiKey.secrets];
}

function checkApiKey(
  config: ApiKeyProviderConfig,
  request: ChannelRequest,
  env: NodeJS.ProcessEnv
): BuiltinAuthContext {
  const presented = bearer(request.headers['authorization']);
  if (!presented) {
    throw new UserFacingError(
      'UNAUTHENTICATED',
      'missing API key (Authorization header)'
    );
  }
  const keys = config.secrets.filter((name) => env[name]);
  if (keys.length === 0) {
    // initChannel checks declared secrets at startup, so this means the env
    // changed underneath us. Not the caller's fault: a plain 500.
    throw new Error(
      `No API key is set (${config.secrets.join(', ')}); check the channel's env.`
    );
  }
  // Compare against every key so timing doesn't reveal which one is close.
  let keyName: string | undefined;
  for (const name of keys) {
    if (sameSecret(presented, env[name] ?? '') && !keyName) keyName = name;
  }
  if (!keyName) throw new UserFacingError('PERMISSION_DENIED', 'invalid API key');
  return { auth: { provider: 'apiKey', keyName } };
}

/** The header value without an optional `Bearer ` prefix. */
function bearer(header: string | undefined): string | undefined {
  // `(\s+|$)`: a bare "Bearer" (trimmed from "Bearer ") is an empty token.
  const value = header?.trim().replace(/^bearer(\s+|$)/i, '');
  return value || undefined;
}

/** Constant-time equality. Hashing first makes the lengths match. */
function sameSecret(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}
