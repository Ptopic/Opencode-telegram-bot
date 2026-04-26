import { Router, type Request, type Response } from 'express';
import type { CodeSearchEngine } from '../engine.js';

export function createSearchRouter(engine: CodeSearchEngine): Router {
  const router = Router();

  router.post('/index', async (req: Request, res: Response) => {
    try {
      const { paths, options } = req.body;
      if (!paths || !Array.isArray(paths)) {
        res.status(400).json({ error: 'paths must be an array' });
        return;
      }
      const stats = await engine.indexPaths(paths, options);
      res.json({ success: true, stats });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const stack = error instanceof Error ? error.stack : undefined;
      console.error('[/api/search/index] Error:', message, stack);
      res.status(500).json({ error: message });
    }
  });

  router.post('/search', async (req: Request, res: Response) => {
    try {
      const { query, projectPath, options } = req.body;
      if (!query || typeof query !== 'string') {
        res.status(400).json({ error: 'query must be a string' });
        return;
      }
      const results = await engine.searchWithGraph(query, { ...options, projectPath });
      res.json({ success: true, results });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  router.post('/search/vector-only', async (req: Request, res: Response) => {
    try {
      const { query, projectPath, options } = req.body;
      if (!query || typeof query !== 'string') {
        res.status(400).json({ error: 'query must be a string' });
        return;
      }
      const results = await engine.search(query, { ...options, projectPath });
      res.json({ success: true, results });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  router.get('/stats', async (_req: Request, res: Response) => {
    try {
      const stats = await engine.getStats();
      res.json({ success: true, stats });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  router.delete('/index/:path', async (req: Request, res: Response) => {
    try {
      const path = req.params.path ?? '';
      await engine.removePath(path);
      res.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  router.post('/watch/start', async (req: Request, res: Response) => {
    try {
      const { paths } = req.body;
      if (!paths || !Array.isArray(paths)) {
        res.status(400).json({ error: 'paths must be an array' });
        return;
      }
      engine.startWatching(paths);
      res.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  router.post('/watch/stop', async (_req: Request, res: Response) => {
    try {
      engine.stopWatching();
      res.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  return router;
}

export function createGraphRouter(engine: CodeSearchEngine): Router {
  const router = Router();

  router.get('/search', async (req: Request, res: Response) => {
    try {
      const { q } = req.query;
      if (!q || typeof q !== 'string') {
        res.status(400).json({ error: 'q (query) parameter required' });
        return;
      }
      const nodes = await engine.getGraphNodeByFile(q);
      res.json({ success: true, nodes });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  router.get('/node/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      if (!id) {
        res.status(400).json({ error: 'node id required' });
        return;
      }
      const context = await engine.getGraphContext(id);
      if (!context) {
        res.status(404).json({ error: 'node not found' });
        return;
      }
      res.json({ success: true, ...context });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  router.get('/callers/:qualifiedName', async (req: Request, res: Response) => {
    try {
      const { qualifiedName } = req.params;
      if (!qualifiedName) {
        res.status(400).json({ error: 'qualifiedName required' });
        return;
      }
      const callers = await engine.getGraphCallers(decodeURIComponent(qualifiedName));
      res.json({ success: true, callers });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  router.get('/callees/:qualifiedName', async (req: Request, res: Response) => {
    try {
      const { qualifiedName } = req.params;
      if (!qualifiedName) {
        res.status(400).json({ error: 'qualifiedName required' });
        return;
      }
      const callees = await engine.getGraphCallees(decodeURIComponent(qualifiedName));
      res.json({ success: true, callees });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  router.get('/dead-code', async (_req: Request, res: Response) => {
    try {
      const deadCode = await engine.findDeadCode();
      res.json({ success: true, deadCode });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  return router;
}
