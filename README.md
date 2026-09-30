# dsh-rc

A phone-first remote control for a running `dsh web` server (compatible with DeepSeek Harness).
Independent project, not affiliated with or endorsed by DeepSeek.

Session list, chat with streaming replies, compact tool rows you tap to expand, approval and
question cards above the composer, stop / steer / queue, slash commands, model switching,
image attachments, and a read-only plugins and connectors screen.

No build step. `public/` is plain HTML, CSS and JS. Markdown uses marked and DOMPurify, vendored in `public/vendor/` (their license headers are kept in the files).

## How it is served

dsh refuses API calls from any other origin, so this page must share the origin of dsh web.
With Tailscale Serve, mount it at `/m` beside dsh on port 443:

```
https://<machine>.<tailnet>.ts.net/    -> 127.0.0.1:3080  (dsh web)
https://<machine>.<tailnet>.ts.net/m/  -> 127.0.0.1:3081  (this page, serve.py)
```

1. Start dsh so it trusts your tailnet name:
   `dsh --profile <profile> --no-open --trusted-host <machine>.<tailnet>.ts.net`
2. Serve the page on loopback: `python3 serve.py` (port 3081, override with `DSH_MOBILE_PORT`).
3. Mount both on your tailnet name:
   `tailscale serve --bg 3080` (dsh web at `/`), then
   `tailscale serve --bg --set-path /m http://127.0.0.1:3081` (this page at `/m`)
4. Open `https://<machine>.<tailnet>.ts.net/m/` on your phone. Add it to the home screen for full screen.

`examples/` has user systemd units for both processes.

## Security

dsh has no authentication. Anyone who can reach it can run commands as your user. Keep it
tailnet-only (Tailscale Serve, not Funnel) or behind your own authenticating proxy. dsh itself
blocks settings and credential changes from non-loopback hosts. This page does not edit settings or
credentials, but it can do anything a dsh session can: send prompts, run slash commands, approve
tools, switch models and rename sessions.

## Protocol notes

- RPC: `POST /api/<method>` with `{type:"client-request", rpcId, method, payload}`.
  Typert methods such as `commands/execute` take `payload: {args: {...}}`.
- Events: WebSockets `/api/events.mux` (all sessions) and `/api/events.host` (status). Receive only.
- Approvals and questions are answered with `POST /api/respond` (a client-response).
- Slash commands go through `commands/execute`, not `session.prompt`.
- Tested against dsh 0.1.1-rc.2. Not yet tested against 0.2.x.

## Roadmap

Next, in priority order:

1. **Push notifications** when an approval or question is waiting, a turn finishes, or a turn
   errors. iOS needs the page installed to the home screen, a service worker, and a small
   laptop-side helper that watches `/api/events.*` and sends Web Push (VAPID).
2. **Running now dashboard**: every active session with elapsed time, todo progress
   (`todos` projection), context fill (`contextPressure`, `tokenUsage`), background jobs
   (`session/jobs`) and the subagent tree (`subagent.list`).
3. **Review the work**: render `diff` view cards as real diffs, a per-turn summary card
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
