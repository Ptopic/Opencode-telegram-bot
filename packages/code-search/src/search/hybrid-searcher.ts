/**
 * Hybrid Search Fusion & Ranking Orchestration
 *
 * Combines lexical (BM25), regex, and semantic retrieval into a coherent
 * hybrid ranking flow using Reciprocal Rank Fusion (RRF).
 *
 * Graph is ADDITIVE only — attached after retrieval candidates exist via RRF.
 * Primary search path is lexical + semantic + regex; graph is a reranking boost.
 *
 * Key design:
 * - Query-appropriate ranking: auto-detect semantic vs lexical vs regex weighting
 * - RRF merges ranked results from multiple retrieval modes
 * - Graph boost applied AFTER fusion (not the primary path)
 * - Graph is optional/bypassable — hybrid works WITHOUT graph
 */

import type { CodeChunk } from '../types.js';
import type { Node } from '../graph/types.js';
import type { LexicalResult } from './lexical-searcher.js';
import type { RegexResult } from './regex-search.js';

// ---------------------------------------------------------------------------
// Query & Result Types
// ---------------------------------------------------------------------------

/**
 * Search mode for hybrid retrieval.
 * - 'semantic': Natural language queries about code intent
 * - 'lexical': Identifier/function name queries
 * - 'regex': Pattern queries with special characters
 * - 'hybrid': Auto-detect and combine all modes
 */
export type HybridSearchMode = 'semantic' | 'lexical' | 'regex' | 'hybrid';

/**
 * Input to hybrid search.
 */
export interface HybridQuery {
  /** The search query string */
  query: string;
  /** Search mode. Default: 'hybrid' (auto-detect) */
  mode?: HybridSearchMode;
  /** Optional filters to apply across all retrieval modes */
  filters?: HybridFilters;
  /**
   * If true, attach graph context as additive boost after retrieval.
   * Graph is NOT the primary search path — it reranks after RRF fusion.
   * Default: false
   */
  useGraph?: boolean;
  /** Maximum results to return. Default: 10 */
  limit?: number;
}

/**
 * Filters applied across retrieval modes.
 */
export interface HybridFilters {
  language?: string;
  filePath?: string;
  chunkTypes?: Array<'function' | 'class' | 'module' | 'block' | 'file'>;
}

/**
 * A single retrieval mode's contribution to the final score.
 */
export interface SourceScore {
  mode: 'lexical' | 'regex' | 'semantic';
  rank: number;
  rawScore: number;
  normalizedScore: number;
}

/**
 * Graph context attached to a result (additive, not primary).
 */
export interface GraphContext {
  /** FQN of the symbol in this chunk (if any) */
  fqn?: string;
  /** Graph nodes connected to this chunk's symbol */
  connectedNodes: Node[];
  /** Number of graph edges for this chunk */
  edgeCount: number;
  /** Graph boost applied to this result (0-1) */
  boost: number;
}

/**
 * A hybrid search result with combined scores and per-mode attribution.
 */
export interface HybridResult {
  /** The code chunk */
  chunk: CodeChunk;
  /** Combined RRF score from all retrieval modes */
  combinedScore: number;
  /** Per-mode score breakdown */
  sources: SourceScore[];
  /** Additive graph context (present when useGraph=true) */
  graphContext?: GraphContext;
  /** Which modes contributed to this result */
  contributingModes: Array<'lexical' | 'regex' | 'semantic'>;
}

// ---------------------------------------------------------------------------
// Query Type Detection
// ---------------------------------------------------------------------------

/**
 * Detects the likely query type based on query characteristics.
 * This determines how to weight different retrieval modes.
 */
function detectQueryMode(query: string): HybridSearchMode {
  const trimmed = query.trim();

  // Check for regex-like patterns
  const regexIndicators = /[\\[\](){}*+?.^$|]/;
  if (regexIndicators.test(trimmed)) {
    return 'regex';
  }

  // Check for natural language (semantic) indicators
  const semanticIndicators = [
    /\b(how|what|why|when|where|which)\b/i,
    /\b(does|do|is|are|was|were|can|could|should|would)\b/i,
    /\b(explain|describe|find|show|get|retrieve)\b/i,
    /\b(reason|cause|because|issue|problem|error|failing)\b/i,
    /\b(about|understanding|learn)\b/i,
  ];
  for (const pattern of semanticIndicators) {
    if (pattern.test(trimmed)) {
      return 'semantic';
    }
  }

  // Check for code identifiers (lexical)
  const identifierPattern = /^[\w.$:]+$/;
  if (identifierPattern.test(trimmed)) {
    return 'lexical';
  }

  // Default to hybrid (combine all modes)
  return 'hybrid';
}

/**
 * Computes mode weights based on detected query type.
 * Returns weights for lexical, regex, and semantic modes.
 */
function getModeWeights(
  mode: HybridSearchMode
): { lexical: number; regex: number; semantic: number } {
  switch (mode) {
    case 'semantic':
      return { lexical: 0.2, regex: 0.1, semantic: 0.7 };
    case 'lexical':
      return { lexical: 0.7, regex: 0.1, semantic: 0.2 };
    case 'regex':
      return { lexical: 0.1, regex: 0.8, semantic: 0.1 };
    default:
      return { lexical: 0.35, regex: 0.2, semantic: 0.45 };
  }
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion
// ---------------------------------------------------------------------------

/**
 * RRF constant. Higher values reduce the impact of rank differences.
 * Standard value per literature: 60.
 */
const RRF_K = 60;

/**
 * Computes Reciprocal Rank Fusion score for a document across multiple rankers.
 * score(d) = Σ 1/(k + rank_i(d))
 */
function rrfScore(rank: number): number {
  return 1 / (RRF_K + rank);
}

/**
 * Merges ranked lists from multiple retrieval modes using RRF.
 * Returns a map of chunkId → combined RRF score.
 */
function fuseWithRRF(
  lexicalResults: Map<string, { rank: number; rawScore: number }>,
  regexResults: Map<string, { rank: number; rawScore: number }>,
  semanticResults: Map<string, { rank: number; rawScore: number }>,
  weights: { lexical: number; regex: number; semantic: number }
): Map<string, { combinedScore: number; sources: SourceScore[] }> {
  const fused = new Map<
    string,
    { combinedScore: number; sources: SourceScore[] }
  >();

  // Process lexical results
  for (const [chunkId, { rank, rawScore }] of lexicalResults) {
    const rrf = rrfScore(rank) * weights.lexical;
    const existing = fused.get(chunkId) || {
      combinedScore: 0,
      sources: [],
    };
    existing.combinedScore += rrf;
    existing.sources.push({
      mode: 'lexical',
      rank,
      rawScore,
      normalizedScore: rrf,
    });
    fused.set(chunkId, existing);
  }

  // Process regex results
  for (const [chunkId, { rank, rawScore }] of regexResults) {
    const rrf = rrfScore(rank) * weights.regex;
    const existing = fused.get(chunkId) || {
      combinedScore: 0,
      sources: [],
    };
    existing.combinedScore += rrf;
    existing.sources.push({
      mode: 'regex',
      rank,
      rawScore,
      normalizedScore: rrf,
    });
    fused.set(chunkId, existing);
  }

  // Process semantic results
  for (const [chunkId, { rank, rawScore }] of semanticResults) {
    const rrf = rrfScore(rank) * weights.semantic;
    const existing = fused.get(chunkId) || {
      combinedScore: 0,
      sources: [],
    };
    existing.combinedScore += rrf;
    existing.sources.push({
      mode: 'semantic',
      rank,
      rawScore,
      normalizedScore: rrf,
    });
    fused.set(chunkId, existing);
  }

  return fused;
}

// ---------------------------------------------------------------------------
// Graph Context (Additive Only)
// ---------------------------------------------------------------------------

export interface GraphConnector {
  /**
   * Get FQNs connected to the given FQN via graph edges.
   * Returns a map of FQN → connected node.
   */
  getConnectedFqns(fqn: string): Promise<Map<string, Node>>;

  /**
   * Get all FQNs in the project that appear in graph.
   */
  getAllGraphFqns(): Promise<Set<string>>;
}

/**
 * Default graph connector that uses database nodes/edges.
 */
export class DefaultGraphConnector implements GraphConnector {
  constructor(
    private getNodes: () => Promise<Node[]>,
    private getEdges: () => Promise<Array<{ source: string; target: string; kind: string }>>
  ) {}

  async getConnectedFqns(fqn: string): Promise<Map<string, Node>> {
    const nodes = await this.getNodes();
    const edges = await this.getEdges();

    const fqnToNode = new Map<string, Node>();
    for (const n of nodes) {
      fqnToNode.set(n.qualifiedName, n);
    }

    const connected = new Map<string, Node>();
    for (const edge of edges) {
      if (edge.kind === 'contains') continue;
      const sourceNode = fqnToNode.get(edge.source);
      const targetNode = fqnToNode.get(edge.target);
      if (sourceNode?.qualifiedName === fqn && targetNode) {
        connected.set(targetNode.qualifiedName, targetNode);
      }
      if (targetNode?.qualifiedName === fqn && sourceNode) {
        connected.set(sourceNode.qualifiedName, sourceNode);
      }
    }

    return connected;
  }

  async getAllGraphFqns(): Promise<Set<string>> {
    const nodes = await this.getNodes();
    return new Set(nodes.map(n => n.qualifiedName));
  }
}

/**
 * Applies additive graph boost to fused results.
 * Graph is NOT the primary path — it only boosts candidates found by
 * lexical/semantic/regex retrieval.
 *
 * @param fusedResults - RRF fused results from retrieval modes
 * @param chunks - Map of chunkId → CodeChunk for result chunks
 * @param graphConnector - Graph connector for fetching connections
 * @param graphBoostAmount - Max boost to apply (0-1). Default: 0.3
 * @param limit - Only compute graph context for top N candidates
 */
async function applyGraphBoost(
  fusedResults: Map<string, { combinedScore: number; sources: SourceScore[] }>,
  chunks: Map<string, CodeChunk>,
  graphConnector: GraphConnector | null,
  graphBoostAmount: number = 0.3,
  limit: number = 50
): Promise<
  Map<
    string,
    { combinedScore: number; sources: SourceScore[]; graphContext?: GraphContext }
  >
> {
  if (!graphConnector) {
    // Graph not available — return fused results unchanged
    return fusedResults;
  }

  // Get top N candidates for graph context computation
  const sortedCandidates = Array.from(fusedResults.entries())
    .sort((a, b) => b[1].combinedScore - a[1].combinedScore)
    .slice(0, limit);

  const resultWithGraph = new Map<
    string,
    { combinedScore: number; sources: SourceScore[]; graphContext?: GraphContext }
  >();

  // Pre-fetch all graph FQNs
  const allGraphFqns = await graphConnector.getAllGraphFqns();

  for (const [chunkId, { combinedScore, sources }] of sortedCandidates) {
    const chunk = chunks.get(chunkId);
    if (!chunk) continue;

    const fqn = chunk.fqn;
    let graphContext: GraphContext | undefined;

    if (fqn && allGraphFqns.has(fqn)) {
      // This chunk has a symbol in the graph
      const connected = await graphConnector.getConnectedFqns(fqn);
      const connectedNodes = Array.from(connected.values());

      // Check if any retrieval candidate shares a connection
      let maxBoost = 0;
      for (const connectedNode of connectedNodes) {
        if (fusedResults.has(connectedNode.id)) {
          // This connected node is also a retrieval candidate
          maxBoost = Math.max(maxBoost, graphBoostAmount);
        }
      }

      if (maxBoost > 0 || connectedNodes.length > 0) {
        graphContext = {
          fqn,
          connectedNodes,
          edgeCount: connectedNodes.length,
          boost: maxBoost,
        };
      }
    }

    resultWithGraph.set(chunkId, {
      combinedScore: combinedScore + (graphContext?.boost ?? 0),
      sources,
      graphContext,
    });
  }

  // Add non-top-N results without graph context
  for (const [chunkId, data] of fusedResults) {
    if (!resultWithGraph.has(chunkId)) {
      resultWithGraph.set(chunkId, data);
    }
  }

  return resultWithGraph;
}

// ---------------------------------------------------------------------------
// HybridSearcher
// ---------------------------------------------------------------------------

export interface LexicalSearcherRef {
  search(query: string, options?: { limit?: number; filters?: { language?: string; filePath?: string } }): Promise<LexicalResult[]>;
}

export interface RegexSearcherRef {
  searchRegex(
    pattern: string,
    chunks: Array<{ id: string; content: string; filePath: string; startLine: number; endLine: number; language?: string }>,
    options?: { limit?: number; language?: string; filePath?: string; caseSensitive?: boolean; multiline?: boolean }
  ): Promise<RegexResult[]>;
}

export interface SemanticSearcherRef {
  search(query: string, topK: number): Promise<Array<{ chunk: CodeChunk; score: number }>>;
}

export interface ChunkProvider {
  getAllChunks(
    projectPath: string,
    filters?: { filePath?: string }
  ): Promise<CodeChunk[]>;
}

/**
 * Orchestrates hybrid retrieval combining lexical, regex, and semantic search
 * using Reciprocal Rank Fusion (RRF).
 *
 * Graph is ADDITIVE only — attached after retrieval candidates exist via RRF.
 * Primary search path is lexical + semantic + regex; graph is a reranking boost.
 *
 * @example
 * ```typescript
 * const hybrid = new HybridSearcher({
 *   lexical: lexicalSearcher,
 *   regex: regexSearcher,
 *   semantic: semanticRetrieval,
 *   chunkProvider: db,
 *   graphConnector: graphConnector ?? null, // optional, can be null
 * });
 *
 * const results = await hybrid.search({
 *   query: "How does authentication work?",
 *   mode: 'hybrid',
 *   useGraph: true,
 *   limit: 10,
 * });
 * ```
 */
export class HybridSearcher {
  constructor(private deps: {
    lexical: LexicalSearcherRef;
    regex: RegexSearcherRef;
    semantic: SemanticSearcherRef;
    chunkProvider: ChunkProvider;
    graphConnector?: GraphConnector | null;
  }) {}

  /**
   * Performs hybrid search combining lexical, regex, and semantic retrieval.
   *
   * @param query - HybridQuery with query string, mode, filters, and options
   * @returns Promise<HybridResult[]> ranked results with per-mode attribution
   */
  async search(query: HybridQuery): Promise<HybridResult[]> {
    const {
      query: queryString,
      mode: requestedMode = 'hybrid',
      filters,
      useGraph = false,
      limit = 10,
    } = query;

    // Detect query type if mode is hybrid
    const detectedMode = detectQueryMode(queryString);
    const effectiveMode = requestedMode === 'hybrid' ? detectedMode : requestedMode;

    // Get mode weights based on query type
    const weights = getModeWeights(effectiveMode);

    // Run retrieval modes in parallel
    const [lexicalResults, regexResults, semanticResults] = await Promise.all([
      this.runLexical(queryString, filters, limit, effectiveMode),
      this.runRegex(queryString, filters, limit, effectiveMode),
      this.runSemantic(queryString, limit, effectiveMode),
    ]);

    // Build ranked maps for RRF
    const lexicalMap = this.buildLexicalMap(lexicalResults);
    const regexMap = this.buildRegexMap(regexResults);
    const semanticMap = this.buildSemanticMap(semanticResults);

    // Fuse with RRF
    const fused = fuseWithRRF(lexicalMap, regexMap, semanticMap, weights);

    // Get chunks for all candidates
    const allChunkIds = Array.from(fused.keys());
    const allChunks = await this.deps.chunkProvider.getAllChunks('', filters);
    const chunkMap = new Map<string, CodeChunk>();
    for (const chunk of allChunks) {
      if (allChunkIds.includes(chunk.id)) {
        chunkMap.set(chunk.id, chunk);
      }
    }

    // Apply graph boost ADDITIVELY (if enabled and available)
    const graphConnector = useGraph ? this.deps.graphConnector ?? null : null;
    const withGraph = await applyGraphBoost(
      fused,
      chunkMap,
      graphConnector,
      0.3, // default graph boost
      limit * 2 // compute for top candidates
    );

    // Sort and limit results
    const sortedResults = Array.from(withGraph.entries())
      .sort((a, b) => b[1].combinedScore - a[1].combinedScore)
      .slice(0, limit);

    // Build final HybridResult array
    const results: HybridResult[] = [];
    for (const [chunkId, { combinedScore, sources, graphContext }] of sortedResults) {
      const chunk = chunkMap.get(chunkId);
      if (!chunk) continue;

      const contributingModes = sources.map(s => s.mode);
      results.push({
        chunk,
        combinedScore,
        sources,
        graphContext,
        contributingModes,
      });
    }

    return results;
  }

  private async runLexical(
    query: string,
    filters: HybridFilters | undefined,
    limit: number,
    mode: HybridSearchMode
  ): Promise<LexicalResult[]> {
    if (mode === 'regex') {
      // Regex mode doesn't use lexical
      return [];
    }

    try {
      return await this.deps.lexical.search(query, {
        limit: limit * 2, // Fetch more for RRF headroom
        filters: filters
          ? { language: filters.language, filePath: filters.filePath }
          : undefined,
      });
    } catch (error) {
      console.warn('[HybridSearcher] Lexical search failed:', error);
      return [];
    }
  }

  private async runRegex(
    query: string,
    filters: HybridFilters | undefined,
    limit: number,
    mode: HybridSearchMode
  ): Promise<RegexResult[]> {
    if (mode === 'semantic' || mode === 'lexical') {
      // Semantic/lexical modes don't use regex
      return [];
    }

    try {
      // Need chunks for regex search
      const chunks = await this.deps.chunkProvider.getAllChunks('', filters);
      const chunkRefs = chunks.map(c => ({
        id: c.id,
        content: c.content,
        filePath: c.filePath,
        startLine: c.startLine,
        endLine: c.endLine,
        language: c.language,
      }));

      return await this.deps.regex.searchRegex(query, chunkRefs, {
        limit: limit * 2,
        language: filters?.language,
        filePath: filters?.filePath,
        caseSensitive: false,
        multiline: true,
      });
    } catch (error) {
      console.warn('[HybridSearcher] Regex search failed:', error);
      return [];
    }
  }

  private async runSemantic(
    query: string,
    limit: number,
    mode: HybridSearchMode
  ): Promise<Array<{ chunk: CodeChunk; score: number }>> {
    if (mode === 'regex') {
      // Regex mode doesn't use semantic
      return [];
    }

    try {
      return await this.deps.semantic.search(query, limit * 2);
    } catch (error) {
      console.warn('[HybridSearcher] Semantic search failed:', error);
      return [];
    }
  }

  private buildLexicalMap(
    results: LexicalResult[]
  ): Map<string, { rank: number; rawScore: number }> {
    const map = new Map<string, { rank: number; rawScore: number }>();
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r) continue;
      map.set(r.chunkId, { rank: i + 1, rawScore: r.score });
    }
    return map;
  }

  private buildRegexMap(
    results: RegexResult[]
  ): Map<string, { rank: number; rawScore: number }> {
    const map = new Map<string, { rank: number; rawScore: number }>();
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r) continue;
      // Use chunkId if available, otherwise create a key from filePath+line
      const key = r.chunkId ?? `${r.filePath}:${r.line}`;
      // Regex results don't have scores — use inverse rank as pseudo-score
      map.set(key, { rank: i + 1, rawScore: 1 / (i + 1) });
    }
    return map;
  }

  private buildSemanticMap(
    results: Array<{ chunk: CodeChunk; score: number }>
  ): Map<string, { rank: number; rawScore: number }> {
    const map = new Map<string, { rank: number; rawScore: number }>();
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r) continue;
      map.set(r.chunk.id, { rank: i + 1, rawScore: r.score });
    }
    return map;
  }
}

// ---------------------------------------------------------------------------
// Convenience Exports
// ---------------------------------------------------------------------------

export { detectQueryMode, getModeWeights, rrfScore, fuseWithRRF };