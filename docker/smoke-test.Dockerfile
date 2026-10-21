# Dockerfile for Smoke Test Runner
# Runs automated smoke tests against the swarm services

# Debian-based: the smoke image builds the workspace, which now pulls the
# ONNX runtime (no musl build).
FROM node:22-slim

WORKDIR /app

# Copy smoke-test package.json and install dependencies (fresh install)
COPY docker/smoke-test/package.json ./docker/smoke-test/package.json

# Install without lockfile (to avoid pnpm supply-chain policy issues)
WORKDIR /app/docker/smoke-test
RUN npm install

# Copy source
COPY docker/smoke-test/src ./src
COPY docker/smoke-test/tsconfig.json ./

# Build
RUN npm run build

# Set the working directory
WORKDIR /app/docker/smoke-test

# Run smoke tests
CMD ["node", "dist/index.js"]