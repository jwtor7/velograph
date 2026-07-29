# syntax=docker/dockerfile:1.7
# Build only from the public, filtered context in .dockerignore. This image
# deliberately does not contain any import source, database, or AI credentials.
# node:22.22.3-bookworm-slim, pinned to the official multi-architecture index.
# Update this tag and digest together after reviewing the upstream image.
FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS build

WORKDIR /app
ENV CI=true

RUN corepack enable

# Copy manifests before sources so dependency installation is cached separately
# from application changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/analytics/package.json packages/analytics/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/importers/package.json packages/importers/package.json
COPY packages/insights/package.json packages/insights/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY scripts/configure-git-hooks.mjs scripts/configure-git-hooks.mjs
RUN pnpm install --frozen-lockfile

COPY . .
RUN node scripts/third-party-license-gate.mjs --workspace
# Bundle the API runtime together with its authoritative packaged web assets.
RUN pnpm api:build
# Deploy only the API package and its production dependency graph. Lifecycle
# scripts remain enabled so production native dependencies are built normally.
RUN pnpm --filter @velograph/api deploy --prod --legacy /opt/velograph/api
# The published tar-fs package contains an install-only test archive. Remove
# that exact reviewed fixture and fail if any other archive or dev package
# appears in the production deployment.
RUN cp THIRD_PARTY_NOTICES.md /opt/velograph/api/THIRD_PARTY_NOTICES.md \
    && node scripts/prune-deployed-api.mjs /opt/velograph/api \
    && node scripts/third-party-license-gate.mjs --production-deploy /opt/velograph/api \
    && node scripts/privacy-audit-release.mjs --production-deploy /opt/velograph/api

FROM node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752 AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    VELO_DATA_DIR=/var/lib/velograph \
    VELO_HOST=127.0.0.1 \
    VELO_INTERNAL_PORT=5124 \
    VELO_PROXY_HOST=127.0.0.1 \
    VELO_PROXY_PORT=5123

# The small Node relay preserves the API's loopback authentication boundary and
# rewrites the forwarded Host/Origin to its internal port. `tini` forwards
# signals and reaps both child processes. The host port remains loopback-only
# in docker-compose.yml.
RUN apt-get update \
    && apt-get install --no-install-recommends -y tini \
    && test -s /usr/local/LICENSE \
    && test -s /usr/share/doc/tini/copyright \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /opt/velograph/api /app/api
COPY --chown=node:node docker-entrypoint.sh docker-proxy.mjs /usr/local/bin/
RUN chmod 0555 /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /var/lib/velograph \
    && chown node:node /var/lib/velograph

USER node
EXPOSE 5123

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5123/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
