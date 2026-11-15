# The Testnotary service: the web app as a standalone Next.js server. Nothing in it is specific to
# App Runner; any container host that sets the environment below runs it.
#
#   docker build -f apps/web/Dockerfile -t testnotary-web .      (from the repo root)
#
# Runtime environment (secrets as `secretsmanager:<id>` references, see src/server/secrets.ts):
#   DATABASE_URL            Postgres as the app role
#   GITHUB_API_URL          optional, defaults to https://api.github.com
#   SENTRY_DSN              optional; without it nothing is reported
#   SENTRY_ENVIRONMENT      optional (SENTRY_RELEASE is baked in with --build-arg)
#   AWS_REGION              where the secrets live, when any variable is a reference
#
# The same image runs the one-off jobs:
#   node apps/web/dist/scripts/migrate.mjs     with MIGRATION_DATABASE_URL (the migration role)

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS build
ENV NEXT_TELEMETRY_DISABLED=1 \
    CI=1
RUN corepack enable
WORKDIR /repo
# Dependencies first, from the lockfile only, so a source change reuses this layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter "@testnotary/web..." \
 && pnpm --filter @testnotary/web build \
 && pnpm --filter @testnotary/web build:migrate

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
# The commit the image was built from; Sentry tags events with it.
ARG SENTRY_RELEASE=""
ENV SENTRY_RELEASE=${SENTRY_RELEASE} \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
COPY --from=build --chown=node:node /repo/apps/web/dist/scripts ./apps/web/dist/scripts
COPY --from=build --chown=node:node /repo/apps/web/drizzle ./apps/web/drizzle
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
