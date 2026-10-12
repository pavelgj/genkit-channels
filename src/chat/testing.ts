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
 * genkit-channels/chat/testing: checks any ConversationStore against the
 * contract the conversation loop relies on.
 *
 *   await conversationStoreContract(() => myStore(), { log: console.log });
 *
 * Each rule gets a fresh store from the factory. It throws on the first
 * broken rule, so it works under any test runner.
 */

import { TurnLostError, type ConversationStore, type Turn } from './conversation-store';

export type ContractMessage = { text: string };
export type ContractState = { n: number; blob?: string };
type Store = ConversationStore<ContractMessage, ContractState>;
type ContractTurn = Turn<ContractMessage, ContractState>;

const take = { maxBatch: 10 };
const msg = (id: string) => ({ id, payload: { text: id } });
const ids = (turn: ContractTurn | undefined) =>
  (turn?.messages ?? []).map((m) => m.id).join(',');

function expect(rule: string, ok: boolean, detail: string): void {
  if (!ok) throw new Error(`ConversationStore contract, "${rule}": ${detail}`);
}

function started(rule: string, turn: ContractTurn | undefined): ContractTurn {
  if (!turn) throw new Error(`ConversationStore contract, "${rule}": no turn was started`);
  return turn;
}

async function staleRejected(store: Store, stale: ContractTurn): Promise<boolean> {
  try {
    await store.complete(stale, { handled: [], state: { n: 99 } }, take);
    return false;
  } catch (e) {
    return e instanceof TurnLostError;
  }
}

/** One rule; `run` throws if the store breaks it. */
type Rule = [name: string, run: (store: Store, name: string) => Promise<void>];

const rules: Rule[] = [
  [
    'the first message starts a turn; later ones wait',
    async (store, rule) => {
      const t = started(rule, await store.post('k', msg('1'), take));
      expect(rule, t.key === 'k' && ids(t) === '1', `got messages ${ids(t)}`);
      expect(rule, t.messages[0].attempt === 1, 'the first attempt should be 1');
      expect(rule, t.state === undefined, 'a new conversation should have no state');
      expect(rule, (await store.post('k', msg('2'), take)) === undefined, 'a second turn started');
    },
  ],
  [
    'a repeated id is a no-op',
    async (store, rule) => {
      const t = started(rule, await store.post('k', msg('1'), take));
      await store.post('k', msg('1'), take);
      const next = await store.complete(t, { handled: ['1'] }, take);
      expect(rule, next === undefined, `the duplicate was queued (${ids(next)})`);
      expect(rule, (await store.post('k', msg('1'), take)) === undefined, 'a handled id came back');
    },
  ],
  [
    'complete saves state and hands over what waited, in order',
    async (store, rule) => {
      const t1 = started(rule, await store.post('k', msg('1'), take));
      await store.post('k', msg('2'), take);
      await store.post('k', msg('3'), take);
      const t2 = started(rule, await store.complete(t1, { handled: ['1'], state: { n: 1 } }, take));
      expect(rule, ids(t2) === '2,3', `got messages ${ids(t2)}`);
      expect(rule, t2.state?.n === 1, 'the saved state did not come back');
      expect(rule, t2.token !== t1.token, 'the next turn reused the token');
      expect(rule, (await store.complete(t2, { handled: ['2', '3'] }, take)) === undefined, 'the turn did not end');
      const t3 = started(rule, await store.post('k', msg('4'), take));
      expect(rule, t3.state?.n === 1, 'completing without state lost the saved state');
    },
  ],
  [
    'maxBatch limits a turn',
    async (store, rule) => {
      const t = started(rule, await store.post('k', msg('1'), { maxBatch: 1 }));
      await store.post('k', msg('2'), take);
      await store.post('k', msg('3'), take);
      const next = await store.complete(t, { handled: ['1'] }, { maxBatch: 1 });
      expect(rule, ids(next) === '2', `got messages ${ids(next)}`);
    },
  ],
  [
    'a stale turn is rejected and saves nothing',
    async (store, rule) => {
      const t1 = started(rule, await store.post('k', msg('1'), take));
      await store.post('k', msg('2'), take);
      const t2 = started(rule, await store.complete(t1, { handled: ['1'], state: { n: 1 } }, take));
      expect(rule, (await store.heartbeat(t1)) === false, 'heartbeat accepted a stale turn');
      expect(rule, (await store.heartbeat(t2)) === true, 'heartbeat refused the current turn');
      expect(rule, await staleRejected(store, t1), 'complete with a stale turn must throw TurnLostError');
      const t3 = await store.complete(t2, { handled: [] }, take);
      expect(rule, t3?.state?.n === 1, "the stale turn's state was saved");
      expect(rule, ids(t3) === '2', "the stale turn changed the messages");
    },
  ],
  [
    'unhandled messages come back with a higher attempt',
    async (store, rule) => {
      const t1 = started(rule, await store.post('k', msg('1'), take));
      const t2 = await store.complete(t1, { handled: [] }, take);
      expect(rule, t2?.messages[0]?.attempt === 2, `attempt was ${t2?.messages[0]?.attempt}`);
    },
  ],
  [
    'conversations are independent',
    async (store, rule) => {
      const a = started(rule, await store.post('a', msg('1'), take));
      started(rule, await store.post('b', msg('1'), take));
      await store.complete(a, { handled: ['1'], state: { n: 7 } }, take);
      expect(rule, (await store.post('b', msg('2'), take)) === undefined, "b's turn should still be running");
      const a2 = started(rule, await store.post('a', msg('2'), take));
      expect(rule, a2.state?.n === 7, "a's state was lost");
    },
  ],
  [
    'large state is kept (2 MB)',
    async (store, rule) => {
      const blob = 'x'.repeat(2 * 1024 * 1024);
      const t1 = started(rule, await store.post('k', msg('1'), take));
      await store.complete(t1, { handled: ['1'], state: { n: 1, blob } }, take);
      const t2 = started(rule, await store.post('k', msg('2'), take));
      expect(rule, t2.state?.blob?.length === blob.length, 'the state was lost or cut short');
    },
  ],
];

/** Makes `turn` expire now, for stores whose turns expire. */
export type ExpireTurn = (store: Store, turn: ContractTurn) => Promise<void>;

/**
 * Runs every rule against a fresh store from `makeStore`. For stores whose
 * turns expire, pass `expire` (make a turn expire now, e.g. by moving a fake
 * clock) to check takeover too.
 */
export async function conversationStoreContract(
  makeStore: () => Store | Promise<Store>,
  opts: { log?: (line: string) => void; expire?: ExpireTurn } = {}
): Promise<void> {
  const all = [...rules];
  const { expire } = opts;
  if (expire) {
    all.push([
      'an expired turn is taken over by the next post',
      async (store, rule) => {
        const t1 = started(rule, await store.post('k', msg('1'), take));
        expect(rule, t1.expiresInMs !== undefined, 'an expiring turn must say when (expiresInMs)');
        await expire(store, t1);
        const t2 = started(rule, await store.post('k', msg('2'), take));
        expect(rule, ids(t2) === '1,2', `got messages ${ids(t2)}`);
        expect(rule, t2.messages[0].attempt === 2, 'the redelivered message should be attempt 2');
        expect(rule, (await store.heartbeat(t1)) === false, 'the expired turn is still current');
        expect(rule, await staleRejected(store, t1), 'the expired turn could still complete');
      },
    ]);
  }
  for (const [name, run] of all) {
    await run(await makeStore(), name);
    opts.log?.(`  ok   ${name}`);
  }
}
