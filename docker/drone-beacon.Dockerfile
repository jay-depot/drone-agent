# Dockerfile for Drone Beacon
# Builds the beacon for Docker deployment

FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile

# Copy source code
COPY drone-beacon/src ./drone-beacon/src
COPY drone-beacon/package.json ./drone-beacon/
COPY drone-beacon/bin ./drone-beacon/bin
COPY drone-core/src ./drone-core/src
COPY drone-core/package.json ./drone-core/
COPY tsconfig.base.json ./

# Build the beacon
WORKDIR /app/drone-beacon
RUN pnpm build

# Set working directory
WORKDIR /app/drone-beacon

# Expose the port
EXPOSE 3457

# Health check
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3457/health || exit 1

# Run the beacon
CMD ["node", "dist/index.js"]