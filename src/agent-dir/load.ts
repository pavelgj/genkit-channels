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
 * `loadAgentDir` builds a ready-to-run Genkit instance from a folder of agents.
 *
 * The motivation: many agents are "just" a prompt plus the basic building blocks
 * (filesystem access, skills, a model). Those users should not have to write any
 * runtime code. `loadAgentDir` is the one call that wires it all up:
 *
 *   import { loadAgentDir } from 'genkit-channels/agent-dir';
 *   const ai = loadAgentDir();                 // reads ./agents, "just works"
 *
 * It is also the extension point. Because model providers and named middleware
 * must be registered when the Genkit instance is *constructed* (a `.prompt`'s
 * `use:` block resolves middleware by name against the registry that
 * construction populates), `loadAgentDir` owns the `genkit()` call and merges
 * your extras in, then hands the instance back so you can keep configuring it:
 *
 *   const ai = loadAgentDir({ plugins: [myProvider()] });
 *   ai.defineTool({ ... });                    // referenced by name in a prompt
 *
 * Folder convention:
 *   agents/
 *     myAgent/
 *       agent.prompt          standard agent prompt (model, tools, use: ...)
 *       skills/
 *         <skill>/SKILL.md    auto-wired into the skills middleware
 *
 * Each `agents/<name>/agent.prompt` becomes an agent registered at
 * `/agent/<name>` (via `definePromptAgent`). If the agent folder has a `skills/`
 * dir it is auto-wired into the skills middleware for that agent, and a missing
 * `model` in the prompt falls back to `defaultModel`.
 */

import { anthropic } from '@genkit-ai/anthropic';
import { openAI } from '@genkit-ai/compat-oai/openai';
import { googleAI } from '@genkit-ai/google-genai';
import {
  artifacts,
  fallback,
  filesystem,
  retry,
  skills,
  toolApproval,
} from '@genkit-ai/middleware';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as YAML from 'yaml';
// `genkit/beta` gives us the agent APIs (definePromptAgent, sessions).
import { genkit, type GenkitBeta } from 'genkit/beta';
// loadPromptFolder is the folder loader the framework uses for `promptDir`.
import { loadPromptFolder } from '@genkit-ai/ai';

/** The default model applied to agents whose prompt omits one. */
export const DEFAULT_MODEL = 'googleai/gemini-flash-latest';

/** The default agents directory, relative to the process cwd. */
export const DEFAULT_AGENTS_DIR = './agents';

/** Options for {@link loadAgentDir}. */
export interface LoadAgentDirOptions {
  /**
   * Extra plugins (model providers, vector stores, ...) to register alongside
   * the defaults. Use this to add a provider not covered by the auto set, or any
   * other Genkit plugin your agents need.
   */
  plugins?: unknown[];
  /** Directory containing agent folders. Default `./agents`. */
  dir?: string;
  /**
   * Model applied to an agent whose `agent.prompt` does not set one. Default
   * `googleai/gemini-flash-latest`.
   */
  defaultModel?: string;
  /**
   * The default middleware bundle to install. `'default'` installs the standard
   * set (filesystem, retry, skills, artifacts, fallback, toolApproval). Pass
   * `false` to install none (you can still add your own via `plugins`).
   */
  middleware?: 'default' | false;
  /**
   * Model providers to register. `'auto'` (the default) registers googleAI,
   * openAI and anthropic, but only for the providers whose API key env var is
   * present (so an unset key never throws at init). Pass `false` to register no
   * providers automatically (supply your own via `plugins`).
   */
  models?: 'auto' | false;
}

/**
 * Builds a Genkit instance wired with the default middleware, model providers
 * (by API key), and every agent found under `dir`. Returns the instance so the
 * caller can add custom tools/agents/plugins. See the file header for the full
 * contract and folder convention.
 */
export function loadAgentDir(opts: LoadAgentDirOptions = {}): GenkitBeta {
  const dir = path.resolve(opts.dir ?? DEFAULT_AGENTS_DIR);
  const defaultModel = opts.defaultModel ?? DEFAULT_MODEL;

  const plugins: unknown[] = [];

  // 1) Model providers. Register only those with an API key present so an
  // unconfigured provider never throws during init (openAI/anthropic do).
  if (opts.models !== false) {
    plugins.push(...autoModelProviders());
  }

  // 2) Default middleware bundle. Each `.plugin()` registers the middleware by
  // name so a prompt's `use:` block can reference it (skills, filesystem, ...).
  if (opts.middleware !== false) {
    plugins.push(
      filesystem.plugin(),
      retry.plugin(),
      skills.plugin(),
      artifacts.plugin(),
      fallback.plugin(),
      toolApproval.plugin()
    );
  }

  // 3) The caller's extras win nothing implicitly but coexist in one registry.
  if (opts.plugins?.length) {
    plugins.push(...opts.plugins);
  }

  const ai = genkit({
    plugins: plugins as never,
    model: defaultModel,
  });

  // 4) Load the agent folder into the instance.
  loadAgentsInto(ai, dir, defaultModel);

  return ai;
}

/**
 * Registers every `agents/<name>/agent.prompt` in `dir` as an agent on `ai`.
 * Exposed separately so a custom runtime that built its own instance a
 * different way can still pull in a dir. Most callers use {@link loadAgentDir}.
 */
export function loadAgentsInto(
  ai: GenkitBeta,
  dir: string,
  defaultModel = DEFAULT_MODEL
): string[] {
  const agentsDir = path.resolve(dir);
  if (!fs.existsSync(agentsDir)) return [];

  const names: string[] = [];
  // Stage rewritten prompt files into a flat temp dir named `<name>.prompt` so
  // the framework's folder loader registers each under a clean `<name>` (its
  // subdirectory namespacing would otherwise produce `name/agent`). Rewriting
  // also lets us inject per-agent skill paths and a default model.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'genkit-agents-'));

  for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const agentDir = path.join(agentsDir, entry.name);
    const promptFile = findPromptFile(agentDir, entry.name);
    if (!promptFile) continue;
    stageAgentPrompt(entry.name, promptFile, agentDir, defaultModel, staging);
    names.push(entry.name);
  }

  if (names.length === 0) return [];

  // Register the staged prompts, then wire each into an agent.
  loadPromptFolder(ai.registry, staging, '');
  for (const name of names) {
    ai.definePromptAgent({ promptName: name });
  }
  return names;
}

/** Registers google/openai/anthropic providers whose API key env var is set. */
function autoModelProviders(): unknown[] {
  const providers: unknown[] = [];
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    providers.push(googleAI());
  }
  if (process.env.OPENAI_API_KEY) {
    providers.push(openAI());
  }
  if (process.env.ANTHROPIC_API_KEY) {
    providers.push(anthropic());
  }
  return providers;
}

/**
 * Finds the prompt file inside an agent folder. Prefers `agent.prompt`, then
 * `<name>.prompt`, then the sole `.prompt` file if there is exactly one.
 */
function findPromptFile(agentDir: string, name: string): string | null {
  const preferred = ['agent.prompt', `${name}.prompt`];
  for (const p of preferred) {
    const full = path.join(agentDir, p);
    if (fs.existsSync(full)) return full;
  }
  const prompts = fs
    .readdirSync(agentDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.prompt'))
    .map((e) => e.name);
  if (prompts.length === 1) return path.join(agentDir, prompts[0]);
  return null;
}

/**
 * Reads an agent's prompt, applies the default model and per-agent skill/
 * filesystem wiring, and writes the result to `<staging>/<name>.prompt`.
 */
function stageAgentPrompt(
  name: string,
  srcFile: string,
  agentDir: string,
  defaultModel: string,
  stagingDir: string
): void {
  const raw = fs.readFileSync(srcFile, 'utf8');
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm: Record<string, unknown> =
    (frontmatter ? (YAML.parse(frontmatter) as Record<string, unknown>) : {}) ??
    {};

  // Default the model when the prompt did not pin one.
  if (!fm.model && defaultModel) fm.model = defaultModel;

  let use = normalizeUse(fm.use);

  // Auto-wire this agent's skills/ dir into the skills middleware, unless the
  // author already configured skillPaths explicitly.
  const skillsDir = path.join(agentDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    use = upsertMiddleware(use, 'skills', (cfg) => {
      if (cfg.skillPaths) return cfg;
      return { ...cfg, skillPaths: [skillsDir] };
    });
  }

  // If filesystem is referenced without a root, default it to the agent folder.
  use = mapMiddleware(use, 'filesystem', (cfg) => {
    if (cfg.rootDirectory) return cfg;
    return { ...cfg, rootDirectory: agentDir };
  });

  if (use.length > 0) {
    fm.use = use;
  } else {
    delete fm.use;
  }

  const serializedFm = YAML.stringify(fm).trimEnd();
  const out = `---\n${serializedFm}\n---\n${body}`;
  fs.writeFileSync(path.join(stagingDir, `${name}.prompt`), out);
}

/** A single `use:` entry, normalized to the object form. */
interface UseEntry {
  name: string;
  config: Record<string, unknown>;
}

/** Normalizes a raw `use:` value (strings or objects) to {@link UseEntry}[]. */
function normalizeUse(raw: unknown): UseEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): UseEntry | null => {
      if (typeof item === 'string') return { name: item, config: {} };
      if (item && typeof item === 'object' && 'name' in item) {
        const obj = item as { name: string; config?: Record<string, unknown> };
        return { name: obj.name, config: obj.config ?? {} };
      }
      return null;
    })
    .filter((e): e is UseEntry => e !== null);
}

/** Applies `fn` to the named middleware's config if present. */
function mapMiddleware(
  use: UseEntry[],
  name: string,
  fn: (config: Record<string, unknown>) => Record<string, unknown>
): UseEntry[] {
  return use.map((e) =>
    e.name === name ? { name, config: fn(e.config) } : e
  );
}

/** Like {@link mapMiddleware} but inserts the middleware if it is absent. */
function upsertMiddleware(
  use: UseEntry[],
  name: string,
  fn: (config: Record<string, unknown>) => Record<string, unknown>
): UseEntry[] {
  if (use.some((e) => e.name === name)) return mapMiddleware(use, name, fn);
  return [...use, { name, config: fn({}) }];
}

/** Splits a dotprompt source into `{ frontmatter, body }`. */
function splitFrontmatter(src: string): { frontmatter: string; body: string } {
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/.exec(src);
  if (!m) return { frontmatter: '', body: src };
  return { frontmatter: m[1], body: m[2] };
}
