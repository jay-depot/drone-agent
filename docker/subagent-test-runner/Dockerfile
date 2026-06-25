# Dockerfile for Subagent Test Runner
# Runs subagent integration tests against the drone-agent

FROM node:22-alpine

# Install pnpm globally
RUN npm install -g pnpm

WORKDIR /app

# Copy root workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./

# Copy drone-agent package files
COPY drone-agent/package.json drone-agent/pnpm-lock.yaml drone-agent/tsconfig.json drone-agent/vitest.config.ts ./drone-agent/

# Install pnpm dependencies
RUN pnpm install --frozen-lockfile

# Copy drone-agent source and compiled files
COPY drone-agent/src ./drone-agent/src
COPY drone-agent/dist ./drone-agent/dist
COPY drone-agent/bin ./drone-agent/bin
COPY drone-agent/test ./drone-agent/test

# Set working directory
WORKDIR /app/drone-agent

# Default: run subagent tests
CMD ["pnpm", "test", "test/subagent/dispatch.test.ts"]