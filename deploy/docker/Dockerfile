# syntax=docker/dockerfile:1
#
# One image for the intranet deployment: the built Excalidraw app plus the
# backend (Keycloak SSO, storage, realtime collaboration). Build it from the
# repository root:
#
#   docker build -f deploy/docker/Dockerfile -t excalidraw-intranet .
#
# Base images and the npm registry can point to internal mirrors:
#
#   docker build -f deploy/docker/Dockerfile \
#     --build-arg BUILD_IMAGE=registry.intranet.example/node:24-bookworm-slim \
#     --build-arg RUNTIME_IMAGE=registry.intranet.example/node:24-bookworm-slim \
#     --build-arg NPM_REGISTRY=https://nexus.intranet.example/repository/npm/ .

ARG BUILD_IMAGE=node:24-bookworm-slim
ARG RUNTIME_IMAGE=node:24-bookworm-slim

FROM ${BUILD_IMAGE} AS build

WORKDIR /opt/build

ARG NPM_REGISTRY=""

COPY . .

RUN if [ -n "$NPM_REGISTRY" ]; then yarn config set registry "$NPM_REGISTRY"; fi

# do not ignore optional dependencies:
# Error: Cannot find module @rollup/rollup-linux-x64-gnu
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
    yarn --frozen-lockfile --network-timeout 600000

ARG GIT_SHA=""
RUN VITE_APP_GIT_SHA="$GIT_SHA" yarn build:app:docker \
 && yarn --cwd ./excalidraw-server build

FROM ${RUNTIME_IMAGE}

ENV NODE_ENV=production \
    STATIC_DIR=/app/public \
    PORT=8080

WORKDIR /app

# the server is bundled into a single file: no node_modules needed at runtime
COPY --from=build /opt/build/excalidraw-app/build /app/public
COPY --from=build /opt/build/excalidraw-server/dist/server.mjs /app/server.mjs
COPY --from=build /opt/build/excalidraw-server/dist/server.mjs.LEGAL.txt /app/THIRD-PARTY-NOTICES.txt

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "/app/server.mjs"]
