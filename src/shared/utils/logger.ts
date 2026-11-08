import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  // Default level ay 'info'. Pwedeng palitan sa .env ng LOG_LEVEL=debug
  level: process.env.LOG_LEVEL || 'info',

  // Kung nasa development (localhost), pagandahin ang output sa terminal
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard', // Format ng oras (ex: 2026-11-01 05:53:00)
        ignore: 'pid,hostname',        // Tanggalin ang mga hindi kailangang system data sa terminal
        singleLine: true,
      },
    },
  }),
});
