# Integration Test Runner
FROM node:22-slim

WORKDIR /app

# Native modules in the workspace need build tooling.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy workspace manifests first for dependency install layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json tsconfig.test.json ./

# Copy workspace packages and integration-test assets.
COPY drone-agent ./drone-agent
COPY drone-core ./drone-core
COPY drone-beacon ./drone-beacon
COPY drone-coordinator ./drone-coordinator
COPY drone-coordinator-ui ./drone-coordinator-ui
COPY drone-swarm-common ./drone-swarm-common
COPY drone-gateway ./drone-gateway
COPY docker ./docker
COPY vitest.config.ts vitest.integration.config.ts eslint.config.mjs ./

RUN corepack enable pnpm && pnpm install --frozen-lockfile && pnpm build

# The subagent fixture resolves the drone-agent executable from PATH.
ENV PATH="/app/drone-agent/bin:${PATH}"

# Configure drone-agent to use the echo LLM provider for integration tests.
# This ensures spawned subagents use the echo-llm service rather than ollama.
RUN mkdir -p /root/.drone-agent && \
    echo '{"llm":{"provider":"echo"},"enabledPlugins":["llm","echo"]}' > /root/.drone-agent/config.json
# Run the real integration suite inside the isolated docker network.
CMD ["pnpm", "exec", "vitest", "run", "-c", "vitest.integration.config.ts"]