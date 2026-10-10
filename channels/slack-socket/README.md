# slack-socket

Runs one Genkit agent as a Slack bot over
[Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode): the
bot opens an outbound WebSocket to Slack, so there is no public URL to set up.
Good for local development, and on Cloud Run it runs as a warm private service.

What the bot does:

- **@mention in a channel**: replies in a thread under the message. Each thread
  is its own conversation (and agent session).
- **DM**: each message starts a thread; replies in that thread continue it.
- **Replies in a thread it answered in** (`followThreads`, on by default):
  keeps answering without another @mention.

Replies stream with Slack's native text streaming, with an "is thinking..."
status until the first words arrive.

## Create the Slack app (about 5 minutes, web UI only)

1. Go to https://api.slack.com/apps, **Create New App**, **From a manifest**,
   pick your workspace, and paste [`manifest.json`](./manifest.json) (JSON
   tab). Change the name if you like.
2. **Basic Information**, **App-Level Tokens**, **Generate Token and Scopes**:
   any name, add the `connections:write` scope. Copy the `xapp-...` token: this
   is `SLACK_APP_TOKEN`.
3. **Install App**, **Install to Workspace**, allow. Copy the **Bot User OAuth
   Token** (`xoxb-...`): this is `SLACK_BOT_TOKEN`.
4. In Slack, invite the bot to a channel: `/invite @Genkit Agent`.

Put both tokens in your project's `.env.local`:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

If you change scopes or events later, Slack asks you to reinstall the app.

## Configure

```yaml
deployments:
  - name: slack-bot
    channel: slack-socket
    expose:
      agent: weatherAgent
    secrets: [GEMINI_API_KEY] # the app's; the Slack tokens are the channel's
    with:
      followThreads: true # default
      stream: native # or `edit` (post, then debounced chat.update)
      streamEditIntervalMs: 700 # for `stream: edit`
```

## Notes

- **One instance.** Every instance opens its own Socket Mode connection and
  Slack spreads events across them; keep `maxInstances: 1`.
- **Followed threads are in memory.** After a restart the bot needs a fresh
  @mention to pick a thread back up. The conversation itself is kept (the
  session id comes from the thread), as long as the agent's store survives.
- **Messages in one thread run one at a time**, in order. Different threads
  run in parallel.
- **Streaming**: if your workspace doesn't support native streaming
  (`chat.startStream` errors), set `stream: edit`.
