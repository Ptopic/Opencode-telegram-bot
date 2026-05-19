import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Reranker } from '../src/search/reranker.js';
import type { SearchResult } from '../src/types.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeResult(id: string, content: string, score: number): SearchResult {
  return {
    chunk: {
      id,
      filePath: `/test/${id}.ts`,
      content,
      startLine: 1,
      endLine: 10,
      language: 'typescript',
      chunkType: 'function',
      metadata: {},
    },
    score,
    query: 'test',
    highlights: [],
  };
}

describe('Reranker', () => {
  let reranker: Reranker;

  beforeEach(() => {
    reranker = new Reranker({ apiKey: 'test-key' });
    mockFetch.mockReset();
  });

  it('reranks documents via Jina API', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          { index: 1, relevance_score: 0.95, document: { text: 'doc 1' } },
          { index: 0, relevance_score: 0.8, document: { text: 'doc 0' } },
        ],
      }),
    });

    const results = await reranker.rerank('test query', ['doc 0', 'doc 1']);
    expect(results).toHaveLength(2);
    expect(results[0]!.index).toBe(1);
    expect(results[0]!.relevanceScore).toBe(0.95);
    expect(results[1]!.index).toBe(0);
    expect(results[1]!.relevanceScore).toBe(0.8);
  });

  it('falls back on API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const results = await reranker.rerank('test query', ['doc 0', 'doc 1']);
    expect(results).toHaveLength(2);
    expect(results[0]!.relevanceScore).toBeGreaterThan(results[1]!.relevanceScore);
  });

  it('falls back on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const results = await reranker.rerank('test query', ['doc 0', 'doc 1']);
    expect(results).toHaveLength(2);
  });

  it('limits documents to maxDocuments for cost control', async () => {
    const smallReranker = new Reranker({ apiKey: 'test-key', maxDocuments: 3 });
    const docs = Array.from({ length: 10 }, (_, i) => `doc ${i}`);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ results: [] }),
    });

    await smallReranker.rerank('test', docs);

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.documents).toHaveLength(3);
  });

  it('rerankSearchResults reorders SearchResult[]', async () => {
    const searchResults = [
      makeResult('a', 'function auth()', 0.5),
      makeResult('b', 'function login()', 0.7),
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          { index: 1, relevance_score: 0.95, document: { text: 'function login()' } },
          { index: 0, relevance_score: 0.6, document: { text: 'function auth()' } },
        ],
      }),
    });

    const reranked = await reranker.rerankSearchResults('login', searchResults);
    expect(reranked[0]!.chunk.id).toBe('b');
    expect(reranked[0]!.score).toBe(0.95);
    expect(reranked[1]!.chunk.id).toBe('a');
  });

  it('preserves original score in chunk.metadata', async () => {
    const searchResults = [makeResult('a', 'content', 0.5)];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          { index: 0, relevance_score: 0.9, document: { text: 'content' } },
        ],
      }),
    });

    const reranked = await reranker.rerankSearchResults('query', searchResults);
    expect(reranked[0]!.chunk.metadata.originalScore).toBe(0.5);
  });

  it('handles empty results', async () => {
    const reranked = await reranker.rerankSearchResults('query', []);
    expect(reranked).toEqual([]);
  });
});
