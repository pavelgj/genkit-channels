# http-auth

An agent and a flow over HTTP, where the app decides who may call it. The app
defines a **context provider**; the channel runs it before every request and
passes what it returns to the agent's tools and the flow as `context`.

```js
// index.mjs
import { defineContextProvider } from 'genkit-channels/app';

defineContextProvider(ai, { name: 'apiKey' }, async (req) => {
  const uid = users.get(bearerToken(req.headers['authorization']));
  if (!uid) throw new UserFacingError('PERMISSION_DENIED', 'unknown API key');
  return { auth: { uid } };
});

// Tools see the caller: each user only gets their own notes.
ai.defineTool({ name: 'listMyNotes', /* ... */ }, async (_input, { context }) =>
  notes[context.auth?.uid] ?? []
);
```

```yaml
# channels.yaml
    expose:
      agent: notesAgent
      flows: [whoami]
      contextProvider: apiKey
```

No credentials gets a 401, a wrong key a 403. The channel never decides who
gets in; the app does, and the same provider works behind any channel.

## Run it

```bash
cd samples/http-auth
npm install
genkit-channel add ../../channels http

cp .env.example .env.local
# then fill in GEMINI_API_KEY (API_KEYS already has two dev users)

genkit-channel dev notes
```

Then:

```bash
# 401: no key
curl -s -X POST localhost:8080/whoami -H 'content-type: application/json' -d '{}'

# 403: unknown key
curl -s -X POST localhost:8080/whoami -H 'authorization: Bearer nope' \
  -H 'content-type: application/json' -d '{}'

# {"result":{"uid":"alice"}}
curl -s -X POST localhost:8080/whoami -H 'authorization: Bearer dev-key-alice' \
  -H 'content-type: application/json' -d '{}'

# Bob's notes, not Alice's
curl -s -X POST localhost:8080/notesAgent -H 'authorization: Bearer dev-key-bob' \
  -H 'content-type: application/json' -d '{"message":"what are my notes?"}'
```

`notesAgent` has no session store, so it is client-managed: send the `state`
from a response back with the next message to continue the conversation.

## Notes

- `API_KEYS` is a stand-in. A real app verifies a token (Firebase Auth, your
  identity provider) in the provider instead.
- The provider runs in the app's shared box. With `box.route: session`, a
  refused caller never gets a box of its own.
- Go and Python apps: define a flow named `contextProvider/apiKey` that takes
  the request (`method`, `headers`, `input`) and returns the context object.
