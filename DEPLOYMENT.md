# Deployment configuration

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
