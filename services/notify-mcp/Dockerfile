# Backbone notify MCP — Streamable HTTP.
#
# Distroless is possible here only because the port to fetch removed the curl
# subprocess dependency. See docs/01-CONTAINERIZATION.md §2.

# ---- build ----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Dependencies first so the layer caches independently of source changes.
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Drop devDependencies and the test output from what gets copied forward.
RUN npm prune --omit=dev \
 && rm -f dist/*.test.js dist/*.test.d.ts

# ---- runtime --------------------------------------------------------------
# nonroot tag runs as uid 65532. No shell, no package manager, no curl.
FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

EXPOSE 8080
USER nonroot

# No HEALTHCHECK instruction: there is no shell and no curl in the image to run
# one. Kubernetes probes the /healthz and /readyz endpoints over HTTP directly,
# which is the correct layer for this anyway. Compose gets a probe via a
# separate helper -- see compose/docker-compose.yml.

# distroless/nodejs sets ENTRYPOINT to the node binary, so CMD is just args.
CMD ["dist/server.js"]
