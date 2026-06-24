# Dockerfile for Smoke Test Runner
# Runs automated smoke tests against the swarm services

FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile

# Copy test utilities
COPY docker/smoke-test/src ./src
COPY docker/smoke-test/package.json ./

# Build tests
RUN pnpm build

# Run smoke tests
CMD ["node", "dist/index.js"]