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
 * Reading the status of an error that came back from the app.
 *
 * A `GenkitError` thrown in the box does not arrive as a `GenkitError`: box
 * rethrows it as `BoxRuntimeError` (exec runner) or `BoxV1RuntimeError`
 * (podman/remote), both carrying the wire status as `data.code` (16 for
 * UNAUTHENTICATED, 7 for PERMISSION_DENIED, ...). Agent turns fail with
 * `AgentError`, which has the status name in `status`. These helpers read
 * all three.
 */

import {
  GenkitError,
  StatusCodes,
  StatusNameSchema,
  type StatusName,
} from 'genkit';

/** The status of an error from the app (or thrown locally), if it has one. */
export function errorStatus(e: unknown): StatusName | undefined {
  if (e instanceof GenkitError) return e.status;
  if (typeof e !== 'object' || e === null) return undefined;
  // Agent turns fail with `AgentError` (genkit/beta), which is not a
  // GenkitError but carries the status name as a string.
  if ('status' in e && typeof e.status === 'string') {
    const parsed = StatusNameSchema.safeParse(e.status);
    if (parsed.success) return parsed.data;
  }
  if (!('data' in e)) return undefined;
  const { data } = e;
  if (typeof data !== 'object' || data === null || !('code' in data)) {
    return undefined;
  }
  const { code } = data;
  if (typeof code !== 'number') return undefined;
  // A numeric enum maps codes back to names.
  const parsed = StatusNameSchema.safeParse(StatusCodes[code]);
  return parsed.success ? parsed.data : undefined;
}

const HTTP_STATUS: Partial<Record<StatusName, number>> = {
  INVALID_ARGUMENT: 400,
  FAILED_PRECONDITION: 400,
  OUT_OF_RANGE: 400,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  ABORTED: 409,
  RESOURCE_EXHAUSTED: 429,
  CANCELLED: 499,
  UNIMPLEMENTED: 501,
  UNAVAILABLE: 503,
  DEADLINE_EXCEEDED: 504,
};

/** The HTTP status for an error from the app: 401, 403, 400, ..., else 500. */
export function httpStatusFor(e: unknown): number {
  const status = errorStatus(e);
  return (status && HTTP_STATUS[status]) ?? 500;
}

/** True when the app's context provider rejected the caller. */
export function isAuthError(e: unknown): boolean {
  const status = errorStatus(e);
  return status === 'UNAUTHENTICATED' || status === 'PERMISSION_DENIED';
}
