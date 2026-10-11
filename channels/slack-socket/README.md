# slack-socket

Runs one Genkit agent as a Slack bot over
[Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode): the
bot opens an outbound WebSocket to Slack, so there is no public URL to set up.
Good for local development, and on Cloud Run it runs as a warm private service.

What the bot does:

- **@mention in a Slack channel**: replies in a thread under the message. Each thread
  is its own conversation (and agent session).
- **DM**: each message starts a thread; replies in that thread continue it.
- **Replies in a thread it answered in** (`followThreads`, on by default):
  keeps answering without another @mention. This survives restarts: for a
  thread it doesn't know yet, the bot reads it once from Slack to see whether
  it replied there.
- **A bare @mention in a thread** ("@bot" and nothing else): answers whatever
  people posted since its last reply, as one message. Handy after downtime.

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
4. In Slack, invite the bot to a Slack channel: `/invite @Genkit Agent`.

Put both tokens in your project's `.env.local`:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

If you change scopes or events later, Slack asks you to reinstall the app.

### Created the app by hand instead?

Check these, since the manifest normally sets them:

- **Socket Mode**: enabled.
- **Event Subscriptions**: on, with bot events `app_mention`, `message.im`,
  `message.channels` (public channels) and `message.groups` (private
  channels). Without the `message.*` events, follow-up replies in a thread
  (no @mention) and DMs never reach the bot.
- **App Home**: Messages Tab on, with "Allow users to send messages" checked.
- **App Home > Always Show My Bot as Online**: on, if you want the green dot.
  Socket Mode connections don't set presence; this is a static setting
  (`always_online` in the manifest), so the bot looks online even while the
  channel isn't running.

### Nothing happens?

Run with `SLACK_DEBUG=1` to log every payload Slack delivers, before any
filtering:

```bash
SLACK_DEBUG=1 genkit-channel dev slack-bot
```

No `raw:` lines when you message the bot means Slack isn't sending events
(check Event Subscriptions and that the bot is in the Slack channel). `raw:` lines
without a `turn start` mean the bot saw them and chose to ignore them.

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
- **Thread lookups.** Following a thread after a restart, and bare-mention
  catch-up, call `conversations.replies` (at most once per unknown thread per
  process, plus once per bare mention). Internal apps keep Slack's normal
  Tier 3 limit; commercially distributed non-Marketplace apps get much lower
  limits for this method since May 2025. If a lookup fails (rate limited or
  otherwise) the bot just doesn't follow that thread until the next @mention.
- **The conversation itself** is kept across restarts (the session id comes
  from the thread), as long as the agent's store survives.
- **Messages in one thread run one at a time**, in order. Different threads
  run in parallel.
- **Streaming**: if your workspace doesn't support native streaming
  (`chat.startStream` errors), set `stream: edit`.
