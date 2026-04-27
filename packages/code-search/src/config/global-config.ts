/**
 * Global code-search config loader.
 * Reads .opencode-telegram-code-search.json in project root
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GlobalCodeSearchConfig, SearchMode } from '../types.js';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../..');

const CONFIG_PATH = path.join(REPO_ROOT, '.opencode-telegram-code-search.json');

const GlobalConfigSchema = z.object({
  generateSummary: z.boolean().default(true),
  searchMode: z.enum(['hybrid', 'vector-graph', 'vector-only']).default('hybrid'),
  bm25Weight: z.number().min(0).max(1).default(0.25),
  vectorWeight: z.number().min(0).max(1).default(0.35),
  graphWeight: z.number().min(0).max(1).default(0.15),
  summaryWeight: z.number().min(0).max(1).default(0.25),
});

export type ResolvedGlobalConfig = z.infer<typeof GlobalConfigSchema>;

let _cached: ResolvedGlobalConfig | null = null;

export function loadGlobalConfig(): ResolvedGlobalConfig {
  if (_cached) return _cached;

  if (!existsSync(CONFIG_PATH)) {
    _cached = GlobalConfigSchema.parse({});
    return _cached;
  }

  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    _cached = GlobalConfigSchema.parse(raw);
  } catch {
    _cached = GlobalConfigSchema.parse({});
  }

  return _cached;
}

export function getSearchModeOptions(searchMode: SearchMode): {
  useHybrid: boolean;
  useGraph: boolean;
  useSummaryEmbedding: boolean;
} {
  switch (searchMode) {
    case 'hybrid':
      return { useHybrid: true, useGraph: true, useSummaryEmbedding: true };
    case 'vector-graph':
      return { useHybrid: false, useGraph: true, useSummaryEmbedding: true };
    case 'vector-only':
      return { useHybrid: false, useGraph: false, useSummaryEmbedding: true };
  }
}

/** For testing — reset cached config */
export function _clearGlobalConfigCache(): void {
  _cached = null;
}