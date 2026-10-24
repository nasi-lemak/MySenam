# syntax=docker/dockerfile:1.7
#
# MySenam as one immutable image, tagged by the content it was built from
# (scripts/stage.mjs builds it as mysenam:<source digest>). Nothing secret is
# in it: settings, keys and the database address come from the environment
# when a container starts. A proxy and its certificate, where the build
# machine needs them to reach npm, are passed as the predefined proxy build
# arguments (kept out of the image history) and a build secret (never in a
# layer).

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- dependencies: reused while package-lock.json is unchanged
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=proxy_ca,required=false \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm_config_cafile=/run/secrets/proxy_ca; fi; \
    npm ci --no-audit --no-fund

# ---- the production build
FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx next build

# ---- what runs: production dependencies, the build, migrations and scripts
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
# pg_dump and pg_restore for the app's own backups (docs/operations/backups.md).
RUN --mount=type=secret,id=proxy_ca,required=false \
    apt-get update && apt-get install -y --no-install-recommends postgresql-client curl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=secret,id=proxy_ca,required=false \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm_config_cafile=/run/secrets/proxy_ca; fi; \
    npm ci --omit=dev --no-audit --no-fund
# next start reads next.config.ts, which takes TypeScript; nothing else of the dev tools comes along.
COPY --from=deps /app/node_modules/typescript ./node_modules/typescript
COPY --from=build /app/.next ./.next
COPY db ./db
COPY scripts ./scripts
COPY src ./src
COPY next.config.ts tsconfig.json ./
ARG SOURCE_COMMIT=unknown
ARG SOURCE_DIGEST=unknown
LABEL org.opencontainers.image.title="MySenam" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      dev.mysenam.source-digest="${SOURCE_DIGEST}"
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 MYSENAM_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
CMD ["npx", "next", "start", "-p", "3000"]
