# Dockerfile for the mock Echo LLM provider
# This provides deterministic responses for smoke testing
# It echoes back messages with a predictable pattern for testing

FROM node:22-alpine

WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm && pnpm install --frozen-lockfile --prod

# Copy the echo-llm server code
COPY docker/echo-llm ./src

# Set the working directory for the server
WORKDIR /app/src

# Expose the port
EXPOSE 3458

# Health check
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
  CMD node --check dist/index.js || curl -f http://localhost:3458/health || exit 1

# Run the server
CMD ["node", "dist/index.js"]