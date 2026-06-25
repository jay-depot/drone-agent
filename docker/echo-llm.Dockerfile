# Dockerfile for the mock Echo LLM provider
# This provides deterministic responses for smoke testing
# It echoes back messages with a predictable pattern for testing

FROM node:22-alpine

WORKDIR /app

# Install root dependencies for build tools
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile

# Copy echo-llm source and config
COPY docker/echo-llm/src ./docker/echo-llm/src
COPY docker/echo-llm/tsconfig.json ./docker/echo-llm/
COPY docker/echo-llm/package.json ./docker/echo-llm/

# Build echo-llm
WORKDIR /app/docker/echo-llm
RUN pnpm install && pnpm build

# Set the working directory for the server
WORKDIR /app/docker/echo-llm

# Expose the port
EXPOSE 3458

# Health check
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3458/health || exit 1

# Run the server
CMD ["node", "dist/index.js"]