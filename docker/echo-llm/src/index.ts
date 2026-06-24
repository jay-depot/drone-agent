import fastify from "fastify";
import { logger } from "./logger.js";

const DEFAULT_PORT = parseInt(process.env.PORT || "3458", 10);
const DEFAULT_HOST = process.env.HOST || "0.0.0.0";

// Echo LLM configuration
const ECHO_CONFIG = {
  // Maximum tokens to echo back
  maxTokens: parseInt(process.env.MAX_TOKENS || "500", 10),
  // Whether to include the original prompt in the response
  includeOriginal: process.env.INCLUDE_ORIGINAL === "true",
  // Response delay in ms (for testing timeouts)
  responseDelay: parseInt(process.env.RESPONSE_DELAY || "0", 10),
};

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

interface ChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string;
    };
    finish_reason: "stop";
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

function createEchoResponse(request: ChatRequest): ChatResponse {
  // Get the last user message
  const lastUserMessage = [...request.messages].reverse().find(
    (m) => m.role === "user"
  );

  const userContent = lastUserMessage?.content || "";

  // Generate deterministic response based on the prompt
  let echoContent: string;

  if (request.messages.length > 0 && request.messages[0].role === "system") {
    // Include system prompt context in echo
    echoContent = `Echo response to: ${userContent}`;
  } else {
    echoContent = `Echo: ${userContent}`;
  }

  // Add token count estimation (for testing usage tracking)
  const promptTokens = Math.ceil(userContent.length / 4);
  const completionTokens = Math.ceil(echoContent.length / 4);

  return {
    id: `echo-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model || "echo-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: echoContent,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

const app = fastify({ logger });

// Health check endpoint
app.get("/health", async () => {
  return { status: "ok", service: "echo-llm" };
});

// Chat completions endpoint (OpenAI-compatible)
app.post<{ Body: ChatRequest }>("/v1/chat/completions", async (request, reply) => {
  const response = createEchoResponse(request.body);

  // Apply configured delay if set
  if (ECHO_CONFIG.responseDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, ECHO_CONFIG.responseDelay));
  }

  return reply.send(response);
});

// Alternative endpoint path (without /v1 prefix)
app.post<{ Body: ChatRequest }>("/chat/completions", async (request, reply) => {
  const response = createEchoResponse(request.body);

  if (ECHO_CONFIG.responseDelay > 0) {
    await new Promise((resolve) => setTimeout(resolve, ECHO_CONFIG.responseDelay));
  }

  return reply.send(response);
});

// Simple chat endpoint for basic testing
app.post<{ Body: { message: string } }>("/chat", async (request, reply) => {
  const { message } = request.body;
  return reply.send({
    response: `Echo: ${message}`,
    timestamp: Date.now(),
  });
});

// Models listing endpoint (for compatibility)
app.get("/v1/models", async () => {
  return {
    object: "list",
    data: [
      {
        id: "echo-model",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "test",
      },
    ],
  };
});

async function start() {
  try {
    await app.listen({ port: DEFAULT_PORT, host: DEFAULT_HOST });
    logger.info(`Echo LLM provider listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

// Graceful shutdown
const shutdown = async () => {
  logger.info("Shutting down echo-llm...");
  await app.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start();