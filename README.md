# dsh-rc

A phone-first remote control for a running `dsh web` server (compatible with DeepSeek Harness).
Independent project, not affiliated with or endorsed by DeepSeek.

Session list, chat with streaming replies, compact tool rows you tap to expand, approval and
question cards above the composer, stop / steer / queue, slash commands, model switching,
image attachments, a read-only plugins and connectors screen, and Web Push notifications for
approvals, questions, finished turns and errors.

No build step. `public/` is plain HTML, CSS and JS; `server/` is plain Node ESM (Node 22 or newer). Markdown uses
marked and DOMPurify, vendored in `public/vendor/` (their license headers are kept in the files).

## Setup

```
npm install
npm start
```

`npm install` pulls the single runtime dependency (`web-push`). `npm start` runs
`node server/index.mjs`. `npm test` runs the Node test runner (`node --test`).

## How it is served

dsh refuses API calls from any other origin, so this page must share the origin of dsh web.
With Tailscale Serve, mount it at `/m` beside dsh on port 443:

```
https://<machine>.<tailnet>.ts.net/    -> 127.0.0.1:3080  (dsh web)
https://<machine>.<tailnet>.ts.net/m/  -> 127.0.0.1:3081  (this page, node server/index.mjs)
```

1. Start dsh so it trusts your tailnet name:
   `dsh --profile <profile> --no-open --trusted-host <machine>.<tailnet>.ts.net`
2. Serve the page on loopback: `npm start` (or `node server/index.mjs`). It listens on
   127.0.0.1:3081 and never binds 0.0.0.0. Override the port with `DSH_RC_PORT`.
3. Mount both on your tailnet name:
   `tailscale serve --bg 3080` (dsh web at `/`), then
   `tailscale serve --bg --set-path /m http://127.0.0.1:3081` (this page at `/m`)
4. Open `https://<machine>.<tailnet>.ts.net/m/` on your phone. Add it to the home screen for full screen.

`examples/` has user systemd units for both processes.

## Notifications

The server also watches dsh's event sockets (`/api/events.mux` and `/api/events.host`,
read-only, with capped reconnect backoff) and sends a Web Push notification with VAPID when:

- an approval is requested (title "Approval needed", with the tool name and reason),
- a question is waiting (title "Question waiting"),
- a turn finishes (title "Turn finished"),
- an agent or stream error arrives (title "Error", with the message).

Subagent sessions are ignored, the session title is included when known, repeats with the same
tag are debounced for 5 seconds, and subscriptions that answer 404 or 410 are removed. Tapping a
notification focuses an open dsh-rc window and opens that session, or opens `./index.html#s=<id>`.

In the app, open a session, tap ⋯ and pick **Notifications**. Turning on must happen from that tap
(browsers, iOS especially, only grant the permission from a user gesture). The sheet shows the
state (on / off / unsupported), and offers **Send test**, which notifies every subscribed device.

iOS notes: notifications only work in a web app added to the Home Screen (Share, then Add to
Home Screen), on iOS 16.4 or newer. The origin must be HTTPS, which the Tailscale Serve mount
already provides. In a plain Safari tab, add it to the Home Screen first and open it from there.

State lives outside the repo, in `$DSH_RC_STATE_DIR` (default `$XDG_STATE_HOME/dsh-rc`, falling
back to `~/.local/state/dsh-rc`). `vapid.json` (generated on first run) and `subscriptions.json`
are written as 0600 files in a 0700 directory.

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DSH_RC_PORT` | `3081` | Loopback port for the page and push API |
| `DSH_RC_STATE_DIR` | `$XDG_STATE_HOME/dsh-rc` or `~/.local/state/dsh-rc` | Where `vapid.json` and `subscriptions.json` live |
| `DSH_RC_VAPID_SUBJECT` | `mailto:dsh-rc@localhost` | VAPID subject sent with each push |
| `DSH_URL` | `http://127.0.0.1:3080` | dsh web base URL whose event sockets are watched |

Push API (same origin, under `/m/`): `GET ./push/key`, `POST ./push/subscribe`,
`POST ./push/unsubscribe`, `POST ./push/test`. JSON bodies are capped at 16 KB and at most 20
subscriptions are stored; endpoints must be HTTPS.

## Security

dsh has no authentication. Anyone who can reach it can run commands as your user. Keep it
tailnet-only (Tailscale Serve, not Funnel) or behind your own authenticating proxy. dsh itself
blocks settings and credential changes from non-loopback hosts. This page does not edit settings or
credentials, but it can do anything a dsh session can: send prompts, run slash commands, approve
tools, switch models and rename sessions.

The push API is the same: keep the server on loopback and let the reverse proxy expose it only on
your private network.

## Protocol notes

- RPC: `POST /api/<method>` with `{type:"client-request", rpcId, method, payload}`.
  Typert methods such as `commands/execute` take `payload: {args: {...}}`.
- Events: WebSockets `/api/events.mux` (all sessions) and `/api/events.host` (status). Receive only.
- Approvals and questions are answered with `POST /api/respond` (a client-response).
- Slash commands go through `commands/execute`, not `session.prompt`.
- Tested against dsh 0.1.1-rc.2. Not yet tested against 0.2.x.

## Roadmap

Next, in priority order:

1. **Running now dashboard**: every active session with elapsed time, todo progress
   (`todos` projection), context fill (`contextPressure`, `tokenUsage`), background jobs
   (`session/jobs`) and the subagent tree (`subagent.list`).
2. **Review the work**: render `diff` view cards as real diffs, a per-turn summary card
   (files changed, commands run, pass or fail), and plan-mode plans as approve / reject cards.

Later:

- Edit or remove queued messages (`session.updateQueue`).
- @-mention files (`fileReferences/list`), a dictation button, saved prompt templates.
- Fork, archive and export sessions (`session.fork`, `session.export`).
- A setup helper when dsh answers 403 (explain `--trusted-host`).
- Standalone Node server that serves the page and proxies `/api` (Host and Origin preserved),
  so it works without Tailscale path mounting; optional token for LAN use.
- Screenshots from a clean demo instance, test on dsh 0.2.x.

## License

MIT, see `LICENSE`.
