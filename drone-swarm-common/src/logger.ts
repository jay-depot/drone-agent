import pino from 'pino';

export const logger = pino({
  name: 'drone-swarm-common',
  level: process.env.LOG_LEVEL || 'info',
});
