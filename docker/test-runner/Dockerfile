# Test Runner for Integration Testing
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

# Expose port (not needed for test runner, but included for completeness)
EXPOSE 3459

# Run tests
CMD ["npm", "run", "test"]