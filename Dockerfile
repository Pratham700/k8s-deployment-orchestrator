# syntax=docker/dockerfile:1
#
# Multi-stage build for the kdo monorepo. One image serves both roles — the
# API and the web console — selected by the `command:` in docker-compose.yml.
# Best practices: pinned Alpine base, manifest-first layer for dependency
# caching, build artifacts produced in an isolated stage, non-root runtime user.

# ---- base: pnpm via corepack -------------------------------------------------
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN corepack enable
WORKDIR /app

# ---- build: install all deps, build the web app -----------------------------
FROM base AS build
# Copy only manifests first so `pnpm install` is cached until deps change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/core/package.json ./packages/core/
COPY packages/api/package.json ./packages/api/
COPY packages/web/package.json ./packages/web/
COPY packages/cli/package.json ./packages/cli/
RUN pnpm install --frozen-lockfile
# Now the sources (node_modules/.next are excluded via .dockerignore).
COPY . .
# Compile the Next.js production build (the API + CLI run via tsx, no build step).
RUN pnpm --filter @kdo/web build

# ---- runtime: lean, non-root -------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
# Bring over the installed workspace (deps + sources + the built .next output).
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 3000 3001
# Default role is the web console; compose overrides command per service.
CMD ["pnpm", "--filter", "@kdo/web", "start"]
