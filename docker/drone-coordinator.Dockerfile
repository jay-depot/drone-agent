# Dockerfile for Drone Coordinator
# Builds the coordinator for Docker deployment

FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile

# Copy source code
COPY drone-coordinator/src ./drone-coordinator/src
COPY drone-coordinator/package.json ./drone-coordinator/
COPY drone-core/src ./drone-core/src
COPY drone-core/package.json ./drone-core/
COPY tsconfig.base.json ./

# Build the coordinator
WORKDIR /app/drone-coordinator
RUN pnpm build

# Set working directory
WORKDIR /app/drone-coordinator

# Expose the port
EXPOSE 3456

# Health check
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3456/health || exit 1

# Run the coordinator
CMD ["node", "dist/index.js"]