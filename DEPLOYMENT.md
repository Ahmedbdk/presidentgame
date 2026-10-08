# Deployment configuration

## Free hosting: Cloudflare Pages and Render

Use Node.js 24 for both platforms. Keep the backend as one instance because
rooms and sessions are stored in that process's memory. No database is required.

### Render backend

Create a Web Service connected to the GitHub repository and select the **Free**
instance type. Configure:

| Setting | Value |
| --- | --- |
| Root directory | `backend` |
| Build command | `npm ci` |
| Start command | `npm start` |
| `NODE_VERSION` | `24` |
| `NODE_ENV` | `production` |
| `ENABLE_DEBUG_TOOLS` | `false` |
| `CORS_ALLOWED_ORIGINS` | Actual production Pages origin, e.g. `https://president-game.pages.dev` |

Let Render supply `PORT`; the backend binds to `0.0.0.0` on that port.
Do not configure `/` as a health-check endpoint: this backend has no route there.
A 404 at the backend's root URL does not mean Socket.IO is unavailable.

Deploy the backend first and copy its public HTTPS `onrender.com` URL. Until the
Pages URL is known, the existing localhost CORS default can remain temporarily;
public frontend connections will not work until the final allowlist is set.

### Cloudflare Pages frontend

Create a **Pages** project connected to the same GitHub repository:

| Setting | Value |
| --- | --- |
| Root directory | `frontend` |
| Framework preset | React (Vite) |
| Build command | `npm run build` |
| Build output directory | `dist` |
| `NODE_VERSION` | `24` |
| `VITE_SOCKET_URL` | Actual Render HTTPS origin, e.g. `https://president-game.onrender.com` |
| `VITE_ENABLE_DEBUG_TOOLS` | `false` |

Do not set `NODE_ENV=production` for the frontend dependency installation: Vite
is a development dependency and must be installed to build the site. The build
itself produces production assets. Set `VITE_SOCKET_URL` for production builds;
rebuild after changing it. Use the origin without `/socket.io` or any other path.

After the first Pages deployment, copy its stable production `pages.dev` origin
into Render's `CORS_ALLOWED_ORIGINS` and redeploy the backend. Preview deployment
origins are separate and are not automatically allowed. No wildcard is supported.

### Verification and limits

Open the Pages URL in two independent browsers or a normal and private window.
Two normal tabs share session storage credentials through localStorage, so they
are not independent players. Create a room, join it, start a game, play and pass,
and refresh one player to check recovery. In browser developer tools, confirm
that `/socket.io/` requests target Render and the WebSocket upgrade returns 101.

Render Free can sleep after 15 minutes without inbound HTTP traffic or WebSocket
messages. Waking it takes time. Restarts, sleep, and redeployments erase every
in-memory room and session; players must create a new room. A brief disconnect
can recover within the existing 30-second reservation while the process survives.
Each room supports up to 8 players; larger groups need multiple rooms.

Keep both debug flags disabled. Existing operational logs include room codes,
usernames, and socket IDs; session credentials must never be logged.
Do not commit environment files. The tracked `.env.example` files are templates;
the backend reads runtime process variables, not `.env` files automatically.

For local verification on Windows, run `npm test` in `backend`, `npm run build`
in `frontend`, and use `npm start` in `backend` plus `npm run dev` in `frontend`
for development. No production URL variables are needed for the default local setup.

## Local development

No environment variables are required for the standard local setup:

- Vite frontend: `http://localhost:5173`
- Socket.IO backend: `http://localhost:3001`

When `PORT` is not set, the backend listens on `3001`. No port environment
variable is required for local development.

Vite proxies the frontend's same-origin `/socket.io` connection to the local
backend automatically. The backend's default CORS allowlist contains only the
Vite origin.

To override either side locally:

```text
# frontend/.env.local (optional; bypasses the Vite proxy)
VITE_SOCKET_URL=http://localhost:3001

# backend process environment
CORS_ALLOWED_ORIGINS=http://localhost:5173
```

Restart Vite after changing a frontend environment file.

### Development-only debug ranking tools

The debug ranking UI and its server event are independently disabled by
default. To enable the existing tools locally, set both flags:

```text
# frontend/.env.local
VITE_ENABLE_DEBUG_TOOLS=true

# backend process environment
ENABLE_DEBUG_TOOLS=true
```

Restart both processes after changing these values. Do not set either flag in
production. Hiding the frontend UI is not the security boundary: the backend
will reject `debugBecomeRank` unless its own flag is exactly `true`.

## Backend listening port

Deployment platforms commonly assign the backend's listening port. Set the
runtime variable to the provided integer:

```text
PORT=8080
```

Valid configured ports are integers from `1` through `65535`. A missing value
uses the local-development fallback `3001`; an invalid configured value stops
startup with a clear error rather than silently listening on the wrong port.

## Production with separate frontend and backend origins

For a frontend at `https://game.example.com` and backend at
`https://api.example.com`:

```text
# Set when building the frontend
VITE_SOCKET_URL=https://api.example.com

# Set on the backend runtime
CORS_ALLOWED_ORIGINS=https://game.example.com
```

`VITE_SOCKET_URL` is embedded at frontend build time. Rebuild/redeploy the
frontend after changing it.

Multiple approved frontend deployments can be comma-separated:

```text
CORS_ALLOWED_ORIGINS=https://game.example.com,https://staging-game.example.com
```

Origins are exact `http://` or `https://` origins. Wildcards, credentials,
paths, query strings, and fragments are rejected during backend startup.

## Production on one origin

When a reverse proxy serves both the frontend and Socket.IO from the same
origin, omit `VITE_SOCKET_URL`; the production frontend connects to its own
origin. Set the backend allowlist to that public origin:

```text
CORS_ALLOWED_ORIGINS=https://game.example.com
```
