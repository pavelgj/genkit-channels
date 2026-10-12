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

type JsonPrimitive = string | number | boolean | null;

/**
 * An object type whose fields are all plain JSON data. Used as a constraint,
 * `T extends JsonData<T>`, rather than a JSON union type: that way interfaces
 * and optional fields are accepted, while anything with methods (a class
 * instance, a platform SDK object) is a compile error. A mapped type, because
 * TypeScript rejects a conditional type as a self-referencing constraint.
 */
export type JsonData<T> = { [K in keyof T]: JsonField<T[K]> };

// `unknown` fields pass: they hold data whose shape we don't know (an agent's
// opaque state off the wire), not objects we built.
type JsonField<V> = unknown extends V
  ? V
  : V extends JsonPrimitive
  ? V
  : V extends (...args: never[]) => unknown
    ? never
    : V extends ReadonlyArray<infer E>
      ? ReadonlyArray<JsonField<E>>
      : V extends object
        ? JsonData<V>
        : V extends undefined
          ? V // an optional field; dropped when serialized
          : never;
