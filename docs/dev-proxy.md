# Development proxy design

Issue: #25

## Requirements

- One root `pnpm dev` command starts the API on `127.0.0.1:5123` and Vite on
  `127.0.0.1:5124` by default.
- A single Ctrl-C stops both processes. An unexpected exit from either process stops the
  other and fails the command.
- Browser requests through Vite support both read-only and mutating API routes without
  weakening the API's Host, Origin, or CSRF policy.
- Development port overrides are explicit, validated integers. The production web bundle
  remains part of CI.

## Architecture and ownership

`scripts/dev.mjs` is the foreground coordinator. It launches the API entry point and Vite
as direct Node children, waits for either to exit, and owns graceful termination with a
bounded force-stop fallback. It never daemonizes or writes a PID file.
`VELO_PORT` overrides the API port and `VELO_DEV_WEB_PORT` overrides the Vite port; the two
ports must be different.

`apps/web/vite.config.ts` uses a narrow `/api` proxy. Vite changes the upstream Host to the
configured API origin. It changes the Origin header only when the incoming value exactly
matches the configured loopback Vite origin (`127.0.0.1` or `localhost`, including the
configured port). Missing and foreign origins are passed through unchanged.

No route, payload, filename, health value, or location is logged by this layer. The data
directory remains controlled by `VELO_DATA_DIR`; development orchestration does not move or
copy user data.

## Security and failure behavior

- Both listeners remain loopback-only.
- There is no wildcard origin, CORS grant, remote proxy target, or hostname suffix match.
- The API continues to require `x-velograph-request: 1` on mutations.
- Invalid port configuration fails before either child starts and does not echo the
  supplied value.
- A child spawn error or any unexpected child exit returns a non-zero status.
- Shutdown first sends `SIGTERM`, then allows up to twelve seconds for the API's coordinated
  request drain, WAL checkpoint, and database close before a `SIGKILL` fallback.

## Verification

`scripts/dev-proxy.test.mjs` starts the real coordinator with an invented, temporary empty
data directory. It prefers the documented ports but safely selects free loopback ports when
the maintainer is already running Velograph. Through the real Vite proxy it verifies:

1. a GET health request succeeds;
2. a CSRF-tagged PUT settings request succeeds from the configured Vite origin;
3. a foreign Origin remains rejected by the API; and
4. stopping the coordinator releases both listener ports.

The temporary database is deleted after the child processes stop. No fixture or user data
is imported.

## Rollback

Remove the root `dev` script, coordinator, proxy configuration, test, and CI build step.
The built app lifecycle (`pnpm app:start`, `app:stop`, `app:status`, `app:restart`) is
independent and remains available.
