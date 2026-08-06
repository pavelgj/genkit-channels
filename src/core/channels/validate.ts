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
 * Runs a channel's declared JSONata rules against the compose context.
 *  - `validate` rules fail the deploy when they evaluate to a falsy value.
 *  - `warn` rules log a warning when they evaluate to a truthy value.
 */

import jsonata from 'jsonata';
import { logger } from '../../util/logger';
import type { ChannelDefinition, ChannelRule, ComposeContext } from '../types';

/**
 * Evaluates validation rules (throwing on the first failure) and warning rules
 * (logging when triggered). Rules run against the same context object provided
 * to the channel at runtime (minus `actions`, which is only known post-launch).
 */
export async function validateChannelConfig(
  def: ChannelDefinition,
  ctx: ComposeContext
): Promise<void> {
  for (const rule of def.validate ?? []) {
    const result = await evaluate(def, rule, ctx);
    if (!result) {
      throw new Error(
        `Deployment "${ctx.deployment.name}" (${def.name}): ${rule.message}`
      );
    }
  }

  for (const rule of def.warn ?? []) {
    const result = await evaluate(def, rule, ctx);
    if (result) {
      logger.warn(
        `Deployment "${ctx.deployment.name}" (${def.name}): ${rule.message}`
      );
    }
  }
}

async function evaluate(
  def: ChannelDefinition,
  rule: ChannelRule,
  ctx: ComposeContext
): Promise<unknown> {
  try {
    const expr = jsonata(rule.expr);
    return await expr.evaluate(ctx);
  } catch (e: any) {
    throw new Error(
      `Channel "${def.name}": invalid expression "${rule.expr}": ${e.message}`
    );
  }
}
