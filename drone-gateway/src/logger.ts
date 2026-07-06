import pino from 'pino';

export const logger = pino({
  name: 'drone-gateway',
  level: process.env.LOG_LEVEL || 'info',
});
