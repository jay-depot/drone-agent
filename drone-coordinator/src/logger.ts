import pino from "pino";

export const logger = pino({
  name: "drone-coordinator",
  level: process.env.LOG_LEVEL || "info",
});