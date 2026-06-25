# Dummy Agent for Integration Testing
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm install

# Copy source
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Expose port
EXPOSE 3459

# Start the agent
CMD ["node", "dist/index.js"]