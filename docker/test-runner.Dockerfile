# Test Runner for Integration Testing
FROM node:22-alpine

WORKDIR /app

# Copy test-runner package.json 
COPY docker/test-runner/package.json ./docker/test-runner/package.json

# Install dependencies (no vitest needed - we use simple node scripts)
WORKDIR /app/docker/test-runner
RUN npm install

# Copy source
COPY docker/test-runner/src ./src
COPY docker/test-runner/tsconfig.json ./

# Build TypeScript
RUN npm run build

# Set working directory
WORKDIR /app/docker/test-runner

# Run the test runner
CMD ["node", "dist/index.js"]