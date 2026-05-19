import type { SearchResult } from '../types.js';

export interface RerankerConfig {
  apiKey: string;
  model?: string;       // default: 'jina-reranker-v2-base-multilingual'
  baseUrl?: string;     // default: 'https://api.jina.ai/v1/rerank'
  maxDocuments?: number; // default: 50 (cost control)
  timeoutMs?: number;   // default: 10000
}

export interface RerankResult {
  index: number;
  /** 0-1 normalized score */
  relevanceScore: number;
  document: {
    text: string;
  };
}

export class Reranker {
  private config: Required<RerankerConfig>;

  constructor(config: RerankerConfig) {
    this.config = {
      apiKey: config.apiKey,
      model: config.model ?? 'jina-reranker-v2-base-multilingual',
      baseUrl: config.baseUrl ?? 'https://api.jina.ai/v1/rerank',
      maxDocuments: config.maxDocuments ?? 50,
      timeoutMs: config.timeoutMs ?? 10000,
    };
  }

  /**
   * Rerank documents by relevance to query.
   * Falls back to original order on API failure.
   */
  async rerank(
    query: string,
    documents: string[],
    topN?: number
  ): Promise<RerankResult[]> {
    // Limit documents sent (cost control)
    const limitedDocs = documents.slice(0, this.config.maxDocuments);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

      const response = await fetch(this.config.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          query,
          documents: limitedDocs,
          top_n: topN ?? limitedDocs.length,
          return_documents: true,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        console.warn(`[Reranker] API error: ${response.status} ${response.statusText}`);
        return this.fallbackResults(limitedDocs.length);
      }

      const data = await response.json() as { results?: Array<{ index: number; relevance_score: number; document?: { text?: string } }> };

      return (data.results ?? []).map((r) => ({
        index: r.index as number,
        relevanceScore: r.relevance_score as number,
        document: { text: r.document?.text ?? limitedDocs[r.index] ?? '' },
      }));
    } catch (error) {
      console.warn(`[Reranker] Failed, falling back to original order:`,
        error instanceof Error ? error.message : error);
      return this.fallbackResults(limitedDocs.length);
    }
  }

  private fallbackResults(count: number): RerankResult[] {
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      relevanceScore: 1 - (i / count),
      document: { text: '' },
    }));
  }

  async rerankSearchResults(
    query: string,
    results: SearchResult[],
    topN?: number
  ): Promise<SearchResult[]> {
    if (results.length === 0) return results;

    const documents = results.map(r => r.chunk.content);
    const rerankResults = await this.rerank(query, documents, topN);

    const reranked = rerankResults
      .map(rr => {
        const original = results[rr.index];
        if (!original) return null;
        return {
          ...original,
          score: rr.relevanceScore,
          chunk: {
            ...original.chunk,
            metadata: { ...original.chunk.metadata, originalScore: original.score },
          },
        } as SearchResult;
      })
      .filter((r): r is SearchResult => r !== null);

    // Add any results not covered by reranker (beyond maxDocuments)
    const rerankedIndices = new Set(rerankResults.map(r => r.index));
    const remaining = results
      .filter((_, i) => !rerankedIndices.has(i));

    return [...reranked, ...remaining];
  }
}
