import okapiBM25 from 'okapibm25';
import { tokenizeCode } from './tokenizer.js';

export interface BM25Config {
  k1: number;
  b: number;
  avgDocLength: number;
}

export interface BM25Result {
  index: number;
  score: number;
}

export class CodeBM25 {
  private tokenizedDocs: string[] = [];
  private metadata: Array<Record<string, unknown>> = [];

  index(documents: string[], metadata?: Array<Record<string, unknown>>): void {
    this.metadata = metadata ?? [];
    this.tokenizedDocs = documents.map(doc => tokenizeCode(doc).join(' '));
  }

  search(query: string, optionsOrLimit?: { k1?: number; b?: number; minScore?: number; limit?: number } | number): BM25Result[] {
    const opts = typeof optionsOrLimit === 'number'
      ? { limit: optionsOrLimit }
      : optionsOrLimit;
    const k1 = opts?.k1 ?? 1.5;
    const b = opts?.b ?? 0.75;
    const minScore = opts?.minScore ?? 0;
    const limit = opts?.limit ?? 10;

    const queryTerms = tokenizeCode(query);
    if (queryTerms.length === 0) return [];

    const scores = okapiBM25(this.tokenizedDocs, queryTerms, { k1, b }) as number[];

    const results: BM25Result[] = [];
    for (let i = 0; i < scores.length; i++) {
      const score = scores[i];
      if (score !== undefined && score > minScore) {
        results.push({ index: i, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  getMetadata(index: number): Record<string, unknown> | undefined {
    return this.metadata[index];
  }
}

export { CodeBM25 as BM25 };
