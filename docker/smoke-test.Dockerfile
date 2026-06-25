# Dockerfile for Smoke Test Runner
# Runs automated smoke tests against the swarm services

FROM node:22-alpine

WORKDIR /app

# Install root dependencies for build tools
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile

# Copy smoke-test source and config
COPY docker/smoke-test/src ./docker/smoke-test/src
COPY docker/smoke-test/tsconfig.json ./docker/smoke-test/
COPY docker/smoke-test/package.json ./docker/smoke-test/

# Build smoke-test
WORKDIR /app/docker/smoke-test
RUN pnpm install && pnpm build

# Run smoke tests
CMD ["node", "dist/index.js"]