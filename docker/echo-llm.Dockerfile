# Dockerfile for the mock Echo LLM provider
# This provides deterministic responses for smoke testing

FROM node:22-alpine

WORKDIR /app

# Copy echo-llm package.json 
COPY docker/echo-llm/package.json ./docker/echo-llm/package.json

# Install ALL dependencies (including devDependencies for TypeScript)
WORKDIR /app/docker/echo-llm
RUN npm install --include=dev

# Copy source
COPY docker/echo-llm/src ./src
COPY docker/echo-llm/tsconfig.json ./

# Build using local typescript from node_modules
RUN ./node_modules/.bin/tsc -b

# Set the working directory for the server
WORKDIR /app/docker/echo-llm

# Expose the port
EXPOSE 3458

# No health check (alpine doesn't have curl by default)

# Run the server
CMD ["node", "dist/index.js"]