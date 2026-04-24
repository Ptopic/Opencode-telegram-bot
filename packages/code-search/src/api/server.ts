import express from 'express';
import cors from 'cors';
import { CodeSearchEngine } from '../engine.js';
import { createSearchRouter, createGraphRouter } from './routes.js';
import { ServerConfigSchema } from '../config/index.js';
import type { ServerConfig } from '../types.js';

interface ServerOptions {
  engine: CodeSearchEngine;
  config?: Partial<ServerConfig>;
}

export async function startServer(options: ServerOptions): Promise<{ app: express.Application; close: () => Promise<void> }> {
  const config = ServerConfigSchema.parse(options.config ?? {});

  const app = express();

  if (config.cors) {
    app.use(cors());
  }

  app.use(express.json());

  app.use('/api/search', createSearchRouter(options.engine));
  app.use('/api/graph', createGraphRouter(options.engine));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const server = config.host
    ? app.listen(config.port, config.host)
    : app.listen(config.port);

  return {
    app,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
    }),
  };
}
