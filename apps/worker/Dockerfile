# syntax=docker/dockerfile:1.7
# Build from the repo root: docker build -f apps/worker/Dockerfile .

ARG NODE_IMAGE=node:22-trixie-slim

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install -g pnpm@10.34.5
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm fetch --frozen-lockfile

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter foreman-worker...
RUN pnpm --filter @foreman/shared build \
    && pnpm --filter foreman-server build \
    && pnpm --filter foreman-worker build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter foreman-worker deploy --prod --config.minimum-release-age=0 --config.inject-workspace-packages=true /out

FROM ${NODE_IMAGE} AS runtime
# The worker runs the backup job (ADR-007), so it needs the same pinned client as the server.
ARG POSTGRES_MAJOR=16
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-common ca-certificates \
    && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
    && apt-get install -y --no-install-recommends postgresql-client-${POSTGRES_MAJOR} \
    && rm -rf /var/lib/apt/lists/* \
    && pg_dump --version | grep -q " ${POSTGRES_MAJOR}\."
ENV NODE_ENV=production BACKUP_DIR=/backups FOREMAN_BLOB_DIR=/blobs
WORKDIR /app
COPY --from=build /out ./
RUN mkdir -p /backups /blobs && chown node:node /backups /blobs
USER node
CMD ["node", "dist/index.js"]
