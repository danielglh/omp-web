# omp-web

[![CI](https://github.com/danielglh/omp-web/actions/workflows/ci.yml/badge.svg)](https://github.com/danielglh/omp-web/actions/workflows/ci.yml)

Run and operate [omp](https://omp.sh/) coding agents on a remote server through a
browser UI. omp runs on the server; the web UI drives it — start sessions, prompt
the agent, watch streaming transcripts with thinking blocks and tool-call cards,
approve tool calls, monitor subagents, tune omp's config, and resume sessions
from anywhere.

Access is protected by a pre-shared token (see [Authentication](#authentication)),
so it is safe to expose on a server once TLS is in front of it.

## Features

**Sessions**
- Multi-session with a workspace rail: sessions group by working directory, and
  each workspace has its own `+` to spawn sessions with a locked cwd.
- Approval tier per session (`always-ask` / `write` / `yolo`); interactive
  approvals then flow into the browser as Approve/Deny dialogs.
- Resume sessions from omp's own history (`~/.omp/agent/sessions`), filtered by
  cwd; deleting a resumed wrapper never touches the underlying omp session file.
- Sessions survive server restarts: each web session maps to an omp session id
  that is reopened on start.

**Chat**
- Streaming transcript: thinking blocks (collapsible), tool-call cards with live
  execution output, tool results, per-message model/timing footers.
- Composer: slash-command autocomplete (live `/` filter + picker), `@path`
  context insertion with server-side path search, image paste/attach with
  client-side downscale, model / thinking-level chips, steer & stop.
- Extension UI: `select` / `confirm` / `input` / `editor` dialogs (this is how
  tool approvals and login prompts surface), plus widgets, status lines,
  `open_url` links, and slash-command output surfaces.
- Side panel: live subagent tree, context usage + session stats + HTML export.
  Works on narrow screens as a drawer.

**Configuration**
- Settings page: `modelRoles` editor (including the `default` role that drives
  new sessions) plus a searchable catalog of all omp config keys — get/set/reset
  are executed through the real `omp config` CLI, so semantics match exactly.
- **omp assistant**: a special chat session that manages omp itself. It runs in
  a seeded workspace (`<dataDir>/assistant` with a generated `AGENTS.md`
  describing omp's config system) so you can configure omp by conversation —
  "switch my default model to X", "disable these providers", … It follows the
  `modelRoles.default` model; use its ↺ reset to pick up config changes (and to
  clear stale context).

**Authentication** — token gate with server-side sessions and logout; see below.

Responsive from iPhone to desktop (rail and side panel become drawers).

## Architecture

```
Browser (React 19 + Vite + Tailwind v4)     Server (Bun)                        omp
┌──────────────────────────────────┐  REST  ┌────────────────────────┐  spawn   ┌───────────────┐
│ Auth gate (token)                │ ─────► │ Bun.serve              │  stdin   │ omp --mode rpc│
│ Session rail / new / resume      │        │  ├─ /api/* (auth)      │ ───────► │ (JSON lines,  │
│ Transcript + tool cards          │  WS    │  ├─ /ws/sessions/:id   │  stdout  │  chunked v2   │
│ Extension dialogs / approvals    │ ◄───── │  ├─ static web app     │ ◄─────── │  framing)     │
│ Subagents / context panels       │ frames │  └─ session registry   │          └───────────────┘
└──────────────────────────────────┘        └────────────────────────┘
```

Key insight: omp ships a headless embedding mode — `omp --mode rpc` — that speaks
a JSON-lines protocol on stdin/stdout (commands in, events/responses out). The
server spawns one such subprocess per web session and bridges the protocol to
browser WebSockets. No TUI mirroring, no collab relay needed; the agent and all
its tools run on the server machine.

- **Protocol**: after the subprocess signals readiness the server negotiates the
  v2 chunked framing protocol (large frames split into `rpc_chunk` fragments),
  falling back to v1's 1 MB single-frame cap.
- **Live join**: `/ws/sessions/:id` replays a bounded frame ring buffer, then
  auto-hydrates with `get_state` + `get_messages` + model/command lists, and
  subscribes to subagent events. Frames are forwarded to every connected client.
- **Interactive**: `extension_ui_request` frames render as dialogs; answers go
  back through the `extension_ui_response` side-channel. Process-scoped frames
  (pending dialogs, approvals) are dropped on process exit so restarts don't
  leave ghost dialogs.
- **Identity**: after `branch` / `switch_session` the server re-syncs the
  session id/file from `get_state`, so the registry always matches the agent.

### Repository layout

```
shared/   @omp-web/shared — wire types shared by server and web (REST + WS + RPC shapes)
server/   @omp-web/server — Bun server: auth, omp subprocess bridge, session manager,
                            config/omp-CLI bridge, REST + WS, static hosting, mock host
web/      @omp-web/web    — React 19 + Vite + Tailwind v4 UI (dark, monospace-heavy)
```

State lives under the data dir (`~/.omp-web` by default): `sessions.json`
(session registry), `config.json` (server config, e.g. the auth token),
`auth-sessions.json` (live auth sessions), `assistant/` (the omp assistant
workspace).

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3.14
- [omp](https://omp.sh/install) on PATH (or `OMP_WEB_OMP_BIN`), with a
  provider/API key configured (same config omp uses: `~/.omp/…`)
- Not needed for mock mode or server tests

## Quick start

```sh
bun install
bun run dev            # server (:7367) + vite (:5173, proxies /api + /ws) with HMR
```

Open `http://localhost:5173`. For a deployment-ish smoke test without vite:

```sh
bun run build && bun run start   # serves the built UI + API on :7367
```

## Authentication

Access requires a pre-shared token once configured. Put it in
`<dataDir>/config.json` (recommended):

```sh
mkdir -p ~/.omp-web
echo '{ "authToken": "your-secret" }' > ~/.omp-web/config.json
chmod 600 ~/.omp-web/config.json
```

or set `OMP_WEB_TOKEN` (env wins over the file). With no token configured,
auth is disabled — fine for local development.

How it behaves:

- Browsers get a full-screen token prompt; a correct token exchanges for an
  HttpOnly session cookie (30 days). All `/api/*` routes and WebSocket
  upgrades require it.
- Sessions are server-side and revocable: logout (icon next to the theme
  toggle) revokes that session; re-login issues a fresh one. Live sessions
  persist across server restarts (`auth-sessions.json`) and expire
  server-side after 30 days, matching the cookie.
- State-changing requests stamped `Sec-Fetch-Site: cross-site` by the browser
  are refused (drive-by/CSRF hardening); plain reads and links keep working.
- Downloads from `/api/fs/file` always arrive as attachments (agent-authored
  HTML never executes on this origin), and paths resolve through symlinks so a
  link inside a session cwd cannot read outside it.
- Rotating the token immediately invalidates all existing sessions. Changing
  the token (file or env) requires a server restart to take effect.
- The cookie is not `Secure`-flagged so plain-HTTP LAN use works; behind an
  HTTPS reverse proxy, add HSTS at the proxy. Always use TLS on untrusted
  networks.

Reminder: a session with a running agent can execute tools on the server.
Treat the UI as a remote shell and keep the token private.

## Configuration

Environment variables (win over `<dataDir>/config.json`, which currently only
holds `authToken`):

| Variable           | Default      | Meaning                                    |
| ------------------ | ------------ | ------------------------------------------ |
| `OMP_WEB_TOKEN`    | —            | Access token (overrides `config.json`)     |
| `OMP_WEB_PORT`     | `7367`       | HTTP/WS port                               |
| `OMP_WEB_HOST`     | `0.0.0.0`    | Bind address                               |
| `OMP_WEB_DATA_DIR` | `~/.omp-web` | Server state (registry, auth, assistant)   |
| `OMP_WEB_OMP_BIN`  | `omp`        | omp binary path                            |
| `OMP_WEB_CWD`      | `$HOME`      | Default cwd for new sessions               |
| `OMP_WEB_DIST_DIR` | `web/dist`   | Built web assets (prod)                    |
| `OMP_WEB_MOCK`     | —            | `1` = spawn the mock RPC host instead      |
| `OMP_WEB_OMP_ARGS` | —            | Extra args for every omp spawn             |

## Local development

```sh
bun run dev            # server + web with HMR (concurrently)
bun run dev:server     # just the Bun server (:7367)
bun run dev:web        # just vite (:5173)
```

- Vite proxies `/api` and `/ws` to the Bun server, so the browser talks to a
  single origin.
- The server restarts on source change (`bun --watch`). Note: config.json is
  read at boot — touch a server file (or restart) after editing it.
- No omp install needed for UI work: `OMP_WEB_MOCK=1 bun run dev:server` runs
  a scripted mock agent (streams a fake turn, raises approvals, subagents,
  extension widgets, login flow) that the tests also use.

Checks:

```sh
bun run check          # biome (lint + format) + typecheck across packages
bun run test           # server E2E suite (mock host) + web unit tests; no omp needed
```

The E2E suite covers session lifecycle, WS bridging + hydration, extension-UI
roundtrips, approvals, config/models endpoints, assistant seeding, branching,
login flow, auth (gate, cookie exchange, logout revocation, re-login, expiry),
and the security-hardening behaviors (traversal guard, cross-site refusal,
input validation, symlink-safe downloads). The web package adds unit tests for
the markdown/URL safety gates (`web/test/`).

## Production

```sh
bun run build          # bundles web/ (vite) and server/ (bun build)
bun run start          # runs server/dist/index.js on :7367
```

Then open `http://<server>:7367`. If a reverse proxy (nginx/Caddy) terminates
TLS, forward `/api` and `/ws` (WebSocket upgrade) to the server. Set the auth
token as described above before exposing the port.

## Roadmap ideas

- Assistant host-tools: let the omp assistant call omp-web's own management
  API (sessions, registry) instead of just the omp CLI.
- Reuse omp's `collab-web` tool-render components for richer tool cards.
- `Secure` cookie auto-detection when served over HTTPS.
