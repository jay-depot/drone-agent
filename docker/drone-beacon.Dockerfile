# Dockerfile for Drone Beacon
# Uses multi-stage build: first build with pnpm, then copy artifacts

# Stage 1: Build all packages
# Use Debian-based image to match the runtime (node:22-slim), so native modules
# compiled here (better-sqlite3, sqlite-vec) are compatible with glibc at runtime.
FROM node:22-slim AS builder

# Install build dependencies for native Node.js modules (node-pty, better-sqlite3)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./

# Copy all package sources
COPY drone-core ./drone-core
COPY drone-swarm-common ./drone-swarm-common
COPY drone-coordinator-ui ./drone-coordinator-ui
COPY drone-coordinator ./drone-coordinator
COPY drone-beacon ./drone-beacon
COPY drone-agent ./drone-agent

# Install and build using pnpm
RUN corepack enable pnpm && pnpm install --frozen-lockfile && pnpm build

# Stage 2: Runtime
# Use Debian-based image: sqlite-vec-linux-x64 ships a glibc-compiled .so
# that cannot be loaded on Alpine (musl libc).
FROM node:22-slim

# Install openssl for TLS certificate generation
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy ALL artifacts from builder
COPY --from=builder /app/drone-beacon ./drone-beacon
COPY --from=builder /app/drone-coordinator ./drone-coordinator
COPY --from=builder /app/drone-agent ./drone-agent
COPY --from=builder /app/drone-core ./drone-core
COPY --from=builder /app/drone-swarm-common ./drone-swarm-common
COPY --from=builder /app/node_modules ./node_modules

# Create config directory and set ownership
RUN mkdir -p /config && chown -R node:node /config

# Set working directory
ENV PATH="/app/drone-agent/bin:${PATH}"

WORKDIR /app/drone-beacon

# Expose the port
EXPOSE 3457

# Run the beacon
CMD ["node", "dist/index.js", "--config-dir", "/config"]