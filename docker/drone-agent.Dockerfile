# Dockerfile for Drone Agent
# Builds the agent for Docker deployment

FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile

# Copy source code
COPY drone-agent/src ./drone-agent/src
COPY drone-agent/package.json ./drone-agent/
COPY drone-agent/bin ./drone-agent/bin
COPY drone-core/src ./drone-core/src
COPY drone-core/package.json ./drone-core/
COPY tsconfig.base.json ./

# Build the agent
WORKDIR /app/drone-agent
RUN pnpm build

# Set working directory
WORKDIR /app/drone-agent

# Expose the port
EXPOSE 3459

# Run the agent (will connect to beacon)
# The actual command depends on configuration via environment variables
CMD ["node", "dist/index.js"]