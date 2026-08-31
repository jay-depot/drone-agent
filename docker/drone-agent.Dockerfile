# Dockerfile for Drone Agent
# Uses multi-stage build: first build with pnpm, then copy artifacts

# Stage 1: Build all packages
FROM node:22-alpine AS builder

# Install build dependencies for native Node.js modules (node-pty, better-sqlite3)
RUN apk add --no-cache python3 make g++

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
FROM node:22-alpine

WORKDIR /app

# Copy ALL artifacts from builder
COPY --from=builder /app/drone-agent ./drone-agent
COPY --from=builder /app/drone-beacon ./drone-beacon
COPY --from=builder /app/drone-coordinator ./drone-coordinator
COPY --from=builder /app/drone-core ./drone-core
COPY --from=builder /app/node_modules ./node_modules

# Set working directory
WORKDIR /app/drone-agent

# Run the agent on React's production reconciler: the dev build instruments
# every component commit with performance.measure entries that are never
# cleared, filling Node's 1M-entry global User Timing buffer (and its
# memory) in long TUI sessions.
ENV NODE_ENV=production

# Expose the port
EXPOSE 3459

# Run the agent (will connect to beacon)
CMD ["node", "dist/index.js"]