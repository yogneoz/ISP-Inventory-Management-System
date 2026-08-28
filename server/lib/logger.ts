/**
 * Structured logger (pino). Silent / pretty-less in test.
 */
import pino from 'pino';

const isTest = process.env.NODE_ENV === 'test';
const level = process.env.LOG_LEVEL || (isTest ? 'silent' : process.env.NODE_ENV === 'production' ? 'info' : 'debug');

export const logger = pino({
  level,
  base: {
    service: 'izone-erp',
    env: process.env.NODE_ENV || 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  redact: {
    paths: [
      'password',
      'newPassword',
      'req.headers.authorization',
      'req.body.password',
      'req.body.newPassword',
      'token',
    ],
    remove: true,
  },
});

export function childLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}

export default logger;
