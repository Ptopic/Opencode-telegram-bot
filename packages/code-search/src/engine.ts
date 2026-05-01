import { Database } from './db/database.js';
import { ChunkManager } from './chunker/chunk-manager.js';
import { Embedder } from './embedder/embedder.js';
import { FileWatcher } from './watcher/file-watcher.js';
import { ChunkSummarizer } from './summarizer/summarizer.js';
// WATCH_TEST_MARKER: Hermestest2026 console.log("WATCH_TEST_2026_05_01");
// FRESH_MARKER_TEST: console.log("FRESH_WATCH_TEST_2026_05_01");
// ROUNDTRIP_TEST: console.log("WATCH_REINDEX_2026_05_01_1234");
import { exactSearch } from './search/exact-search.js';
import type { SearchOptions, IndexOptions, ProjectStats, SearchResult, CodeChunk } from './types.js';
import type { Node, Context } from './graph/types.js';
import { DefaultConfig, type Config } from './config/index.js';
import { loadGlobalConfig, getSearchModeOptions } from './config/global-config.js';

export class CodeSearchEngine {
  private db: Database;
  private chunker: ChunkManager;
  private embedder: Embedder;
  private summarizer: ChunkSummarizer;
  private watcher: FileWatcher | null = null;
  private config: Config;
  private currentProjectPath: string = '';

  constructor(config: Partial<Config> = {}) {
    this.config = { ...DefaultConfig, ...config };
    this.db = new Database({
      uri: this.config.database.uri,
      codeChunksTable: this.config.database.codeChunksTable,
      dependencyGraphTable: this.config.database.dependencyGraphTable,
    });
    this.chunker = new ChunkManager({
      maxChunkSize: this.config.chunking.maxChunkSize ?? 1000,
      overlap: this.config.chunking.overlap ?? 100,
      strategy: this.config.chunking.strategy ?? 'chonkie',
    }, this.db);
    this.embedder = new Embedder({
      provider: this.config.embedder.provider,
      model: this.config.embedder.model,
      apiKey: this.config.embedder.apiKey,
      baseUrl: this.config.embedder.baseUrl,
      batchSize: this.config.embedder.batchSize,
      maxRetries: this.config.embedder.maxRetries,
      baseDelayMs: this.config.embedder.baseDelayMs,
      interBatchDelayMs: this.config.embedder.interBatchDelayMs,
    });
    this.summarizer = new ChunkSummarizer({
      provider: 'openai',
      apiKey: this.config.embedder.apiKey,
    });
  }

  async initialize(): Promise<void> {
    await this.db.initialize();
  }

  async indexPaths(paths: string[], options?: Partial<IndexOptions>): Promise<ProjectStats> {
    this.currentProjectPath = paths[0] ?? '';

    console.log('[CodeSearchEngine] Getting indexed file hashes...');
    const indexedHashes = await this.db.getIndexedFileHashes(this.currentProjectPath);
    console.log('[CodeSearchEngine] Found', indexedHashes.size, 'indexed files');

    let skippedCount = 0;
    let processedCount = 0;

    const chunks = await this.chunker.chunkDirectory(paths, {
      ...options,
      projectPath: this.currentProjectPath,
      indexedFileHashes: indexedHashes,
      onFileSkipped: (filePath, reason) => {
        if (reason === 'unchanged') {
          skippedCount++;
        }
      },
      onFileProcessed: (filePath, chunkCount) => {
        processedCount++;
      },
    });

    console.log('[CodeSearchEngine] Files:', processedCount, 'indexed,', skippedCount, 'skipped (unchanged)');

    if (chunks.length === 0) {
      console.log('[CodeSearchEngine] No new or changed files to index');
      return this.getStats();
    }

    console.log('[CodeSearchEngine] Total chunks to index:', chunks.length);
    const embeddings = await this.embedder.embedChunks(chunks);

    const globalConfig = loadGlobalConfig();
    const generateSummary = options?.generateSummary ?? globalConfig.generateSummary;
    let chunksWithSummaries: CodeChunk[] = chunks;
    let summaryEmbeddings: number[][] | undefined;

    if (generateSummary) {
      console.log('[CodeSearchEngine] Generating chunk summaries...');
      const summaries = await this.summarizer.summarizeChunks(
        chunks.map(c => ({ content: c.content, filePath: c.filePath }))
      );

      chunksWithSummaries = chunks.map((chunk, i) => ({
        ...chunk,
        summary: summaries[i] || undefined,
      }));

      console.log('[CodeSearchEngine] Generating summary embeddings...');
      summaryEmbeddings = await this.embedder.embedChunks(chunksWithSummaries.map(c => ({
        ...c,
        content: c.summary ?? c.content,
      })));
    } else {
      console.log('[CodeSearchEngine] Skipping summary generation (generateSummary=false)');
    }

    console.log('[CodeSearchEngine] Storing chunks in database...');
    await this.db.upsertChunks(chunksWithSummaries, embeddings, this.currentProjectPath, summaryEmbeddings);
    return this.getStats();
  }

  async search(query: string, options?: Partial<SearchOptions>): Promise<SearchResult[]> {
    const globalConfig = loadGlobalConfig();
    const globalModeOptions = getSearchModeOptions(globalConfig.searchMode);

    const useGraph = options?.useGraph ?? globalModeOptions.useGraph;
    const useHybrid = options?.useHybrid ?? globalModeOptions.useHybrid;
    const useSummaryEmbedding = options?.useSummaryEmbedding ?? globalModeOptions.useSummaryEmbedding;
    const exactWeight = options?.exactWeight ?? 0.4; // default: exact search contributes 40% boost

    const projectPath = this.currentProjectPath;

    // Pure exact search mode — skip all vector/hybrid search
    if (options?.exactSearch) {
      const allChunksForExact = await this.db.getAllChunksForExactSearch(projectPath, options?.filters);
      const exactResults = exactSearch(query, allChunksForExact, {
        threshold: 0.25,
        limit: options?.limit ?? 10,
        fuzzy: false,
        literal: true,
      });

      const results: SearchResult[] = exactResults
        .filter(r => r.score >= 0.3)
        .map(r => {
          const chunk = allChunksForExact.find(c => c.id === r.chunkId)!;
          return {
            chunk: {
              id: chunk.id,
              filePath: chunk.filePath,
              content: chunk.content,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              language: chunk.language ?? 'unknown',
              chunkType: 'block',
              metadata: {},
            },
            score: r.score,
            query,
            highlights: [r.matchedText],
          };
        });

      results.sort((a, b) => b.score - a.score);
      return results.slice(0, options?.limit ?? 10);
    }

    // Step 1: Run exact substring/pattern search (always, it's cheap)
    // This handles: console.log("Test"), JSX fragments, quoted strings, exact substrings
    const allChunksForExact = await this.db.getAllChunksForExactSearch(projectPath, options?.filters);
    const exactResults = exactWeight > 0
      ? exactSearch(query, allChunksForExact, {
          threshold: 0.25,
          limit: options?.limit ?? 10,
          fuzzy: true,
        })
      : [];

    const exactChunkIds = new Map<string, { score: number; matchType: string }>();
    for (const r of exactResults) {
      exactChunkIds.set(r.chunkId, { score: r.score, matchType: r.matchType });
    }

    // Step 2: Run the appropriate hybrid/vector search
    let hybridResults: SearchResult[];

    const searchOptions = {
      ...options,
      projectPath,
      graphBoost: options?.graphBoost ?? globalConfig.graphWeight,
      bm25Weight: options?.bm25Weight ?? globalConfig.bm25Weight,
      vectorWeight: options?.vectorWeight ?? globalConfig.vectorWeight,
      useGraph,
      useHybrid,
      useSummaryEmbedding,
      summaryWeight: options?.summaryWeight ?? globalConfig.summaryWeight,
    };

    if (!globalConfig.generateSummary) {
      const queryEmbedding = await this.embedder.embedQuery(query);
      hybridResults = await this.db.searchHybrid(query, queryEmbedding, searchOptions);
    } else if (useSummaryEmbedding && useHybrid) {
      const queryEmbedding = await this.embedder.embedQuery(query);
      hybridResults = await this.db.searchHybridWithSummary(query, queryEmbedding, queryEmbedding, searchOptions);
    } else if (useHybrid) {
      const queryEmbedding = await this.embedder.embedQuery(query);
      hybridResults = await this.db.searchHybrid(query, queryEmbedding, searchOptions);
    } else if (useGraph) {
      const queryEmbedding = await this.embedder.embedQuery(query);
      hybridResults = await this.db.searchWithGraphBoost(queryEmbedding, searchOptions);
    } else {
      const queryEmbedding = await this.embedder.embedQuery(query);
      hybridResults = await this.db.search(queryEmbedding, searchOptions);
    }

    // Step 3: Boost hybrid results with exact match scores
    if (exactChunkIds.size > 0 && exactWeight > 0) {
      const boosted: SearchResult[] = [];

      for (const result of hybridResults) {
        const exact = exactChunkIds.get(result.chunk.id);
        if (exact) {
          // Exact match boosts the score significantly
          const boostedScore = result.score + (exact.score * exactWeight);
          boosted.push({ ...result, score: Math.min(1, boostedScore) });
        } else {
          boosted.push(result);
        }
      }

      // Step 4: If we have strong exact matches not in hybrid results, prepend them
      const hybridChunkIds = new Set(hybridResults.map(r => r.chunk.id));
      const missingExactMatches = exactResults.filter(
        r => !hybridChunkIds.has(r.chunkId) && r.score >= 0.5
      );

      for (const em of missingExactMatches) {
        // Find the full chunk data
        const chunk = allChunksForExact.find(c => c.id === em.chunkId);
        if (chunk) {
          boosted.push({
            chunk: {
              id: chunk.id,
              filePath: chunk.filePath,
              content: chunk.content,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              language: chunk.language ?? 'unknown',
              chunkType: 'block',
              metadata: {},
            },
            score: em.score * exactWeight,
            query,
            highlights: [em.matchedText],
          });
        }
      }

      boosted.sort((a, b) => b.score - a.score);
      return boosted.slice(0, options?.limit ?? 10);
    }

    return hybridResults.slice(0, options?.limit ?? 10);
  }

  async searchWithGraph(query: string, options?: Partial<SearchOptions & { graphBoost?: number }>): Promise<SearchResult[]> {
    return this.search(query, { ...options, useGraph: true, useHybrid: false });
  }

  async removePath(path: string): Promise<void> {
    await this.db.removeByPath(path);
  }

  async getStats(): Promise<ProjectStats> {
    return this.db.getStats(this.currentProjectPath);
  }

  startWatching(paths: string[]): void {
    if (this.watcher) {
      this.watcher.stop();
    }
    this.watcher = new FileWatcher({
      paths,
      extensions: this.config.watcher.extensions,
      debounceMs: this.config.watcher.debounceMs,
      ignorePatterns: this.config.watcher.ignorePatterns,
    });
    const handleChange = async (filePath: string) => {
      try {
        const { createHash } = await import('crypto');
        const { readFile } = await import('fs/promises');
        const content = await readFile(filePath, 'utf-8');
        const hash = createHash('sha256').update(content).digest('hex');
        const chunks = await this.chunker.chunkFile(filePath, hash);
        const embeddings = await this.embedder.embedChunks(chunks);
        await this.db.upsertChunks(chunks, embeddings, this.currentProjectPath);
        console.log(`[watch] Re-indexed: ${filePath} (${chunks.length} chunks)`);
      } catch (err) {
        console.error(`[watch] Failed to index ${filePath}:`, err instanceof Error ? err.message : err);
      }
    };

    this.watcher.on('change', handleChange);
    this.watcher.on('add', handleChange);
    this.watcher.on('unlink', (filePath: string) => {
      this.removePath(filePath);
      console.log(`[watch] Removed: ${filePath}`);
    });
    this.watcher.start();
  }

  stopWatching(): void {
    this.watcher?.stop();
    this.watcher = null;
  }

  async close(): Promise<void> {
    this.stopWatching();
    await this.db.close();
  }

  async getGraphNode(nodeId: string): Promise<Node | null> {
    return this.db.getNode(nodeId);
  }

  async getGraphNodeByFile(filePath: string): Promise<Node[]> {
    return this.db.getNodesByFile(filePath);
  }

  async getGraphCallers(qualifiedName: string): Promise<Node[]> {
    const allNodes = await this.db.getAllNodes();
    const edges = await this.db.getAllEdges();
    const callerIds = new Set<string>();

    for (const edge of edges) {
      if (edge.kind === 'calls') {
        const targetNode = allNodes.find(n => n.id === edge.target);
        if (targetNode?.qualifiedName === qualifiedName) {
          callerIds.add(edge.source);
        }
      }
    }

    return Array.from(callerIds).map(id => allNodes.find(n => n.id === id)).filter((n): n is Node => n !== undefined);
  }

  async getGraphCallees(qualifiedName: string): Promise<Node[]> {
    const allNodes = await this.db.getAllNodes();
    const edges = await this.db.getAllEdges();
    const calleeIds = new Set<string>();

    for (const edge of edges) {
      if (edge.kind === 'calls') {
        const sourceNode = allNodes.find(n => n.id === edge.source);
        if (sourceNode?.qualifiedName === qualifiedName) {
          calleeIds.add(edge.target);
        }
      }
    }

    return Array.from(calleeIds).map(id => allNodes.find(n => n.id === id)).filter((n): n is Node => n !== undefined);
  }

  async getGraphContext(nodeId: string): Promise<Context | null> {
    const focal = await this.db.getNode(nodeId);
    if (!focal) return null;

    const ancestors = await this.getAncestors(nodeId);
    const children = await this.getChildren(nodeId);

    const incomingEdges = await this.db.getEdgesByNode(nodeId);
    const incomingRefs: Array<{ node: Node; edge: any }> = [];
    for (const edge of incomingEdges) {
      if (edge.kind === 'contains') continue;
      const node = await this.db.getNode(edge.source);
      if (node) incomingRefs.push({ node, edge });
    }

    const outgoingRefs: Array<{ node: Node; edge: any }> = [];
    const outgoingEdges = await this.db.getEdgesByNode(nodeId);
    for (const edge of outgoingEdges) {
      if (edge.kind === 'contains') continue;
      const node = await this.db.getNode(edge.target);
      if (node) outgoingRefs.push({ node, edge });
    }

    const types: Node[] = [];
    const imports: Node[] = [];

    return { focal, ancestors, children, incomingRefs, outgoingRefs, types, imports };
  }

  async findDeadCode(): Promise<Node[]> {
    const allNodes = await this.db.getAllNodes();
    const edges = await this.db.getAllEdges();

    const calledBy = new Map<string, Set<string>>();

    for (const edge of edges) {
      if (edge.kind === 'calls') {
        if (!calledBy.has(edge.target)) calledBy.set(edge.target, new Set());
        calledBy.get(edge.target)!.add(edge.source);
      }
    }

    const deadCode: Node[] = [];

    for (const node of allNodes) {
      if (node.kind === 'import' || node.kind === 'variable' || node.kind === 'constant') continue;
      if (node.kind === 'class' || node.kind === 'function' || node.kind === 'method') continue;

      const hasCallers = calledBy.has(node.id) && calledBy.get(node.id)!.size > 0;
      if (!hasCallers) {
        deadCode.push(node);
      }
    }

    return deadCode;
  }

  private async getAncestors(nodeId: string): Promise<Node[]> {
    const ancestors: Node[] = [];
    const visited = new Set<string>();
    let currentId = nodeId;

    while (true) {
      if (visited.has(currentId)) break;
      visited.add(currentId);

      const containingEdges = await this.db.getEdgesByNode(currentId);
      const containsEdge = containingEdges.find(e => e.kind === 'contains' && e.target === currentId);

      if (!containsEdge) break;

      const parentNode = await this.db.getNode(containsEdge.source);
      if (parentNode) {
        ancestors.push(parentNode);
        currentId = parentNode.id;
      } else {
        break;
      }
    }

    return ancestors;
  }

  private async getChildren(nodeId: string): Promise<Node[]> {
    const edges = await this.db.getEdgesByNode(nodeId);
    const children: Node[] = [];

    for (const edge of edges) {
      if (edge.kind === 'contains' && edge.source === nodeId) {
        const childNode = await this.db.getNode(edge.target);
        if (childNode) children.push(childNode);
      }
    }

    return children;
  }
}

