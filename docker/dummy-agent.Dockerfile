# Dummy Agent for Integration Testing
FROM node:22-alpine

WORKDIR /app

# Copy dummy-agent package.json 
COPY docker/dummy-agent/package.json ./docker/dummy-agent/package.json

# Install dependencies
WORKDIR /app/docker/dummy-agent
RUN npm install

# Copy source
COPY docker/dummy-agent/src ./src
COPY docker/dummy-agent/tsconfig.json ./

# Build TypeScript
RUN npm run build

# Set working directory
WORKDIR /app/docker/dummy-agent

# Expose port
EXPOSE 3459

# Start the agent
CMD ["node", "dist/index.js"]