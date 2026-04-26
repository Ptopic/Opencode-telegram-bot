# Code Search Improvements - Future Roadmap

## Current State

- **Chunking**: AST-based via Chonkiejs (tree-sitter WASM)
- **Nodes**: Classes, functions, methods, interfaces, type aliases, enums, imports
- **Edges**: calls, instantiates, extends
- **Search**: Vector embedding + Graph boosting (now default)
- **Storage**: LanceDB (local vector DB)

## Implemented (2026-04-27)

- [x] Graph + Embedding combo search as default
- [x] `/search/vector-only` endpoint for fallback
- [x] `useGraph` and `graphBoost` config options
- [x] Tree-sitter AST-based chunking via Chonkiejs
- [x] AST-informed symbol extraction
- [x] Node.js 22 requirement for WASM compatibility

---

## Future Improvements (Priority Order)

### 1. Hybrid Search (Keyword + Vector + Graph)

**What**: Combine BM25/keyword exact-match search with vector + graph search.

**Why**: Vector search excels at semantic similarity but misses exact symbol matches. When a user searches "createSearchRouter", exact keyword match should rank highest.

**Implementation**:
```
Query → [Keyword Search] → Exact symbol matches (high weight)
      → [Vector Search] → Semantic similarity
      → [Graph Boost] → Related via call graph
      → [Reranker] → Combine scores
```

**Impact**: High. Fixes "search finds similar but not exact" problem.

---

### 2. Query Expansion via Graph

**What**: Use the knowledge graph to expand query terms with related symbols.

**Why**: Code uses varied terminology. "fetch user data" should find code that uses `getUser`, `loadUser`, `retrieveUserProfile` etc.

**Implementation**:
```
1. Parse query to identify symbol names
2. Find those symbols in graph
3. Get callees/callers of matched symbols
4. Expand query: "fetch user" → ["fetch user", "getUser", "loadUserData", "UserService.get"]
5. Run expanded query against vector index
```

**Impact**: High. Better recall for queries that don't match exact terminology.

---

### 3. Graph-based Reranking (PageRank)

**What**: Use PageRank or betweenness centrality to rerank search results.

**Why**: Highly connected functions (many callers/callees) are often more important than isolated ones.

**Implementation**:
```
1. Compute PageRank scores for all nodes in graph
2. At search time, boost results from high-PageRank nodes
3. Formula: final_score = vector_score + (graph_boost * page_rank_normalized)
```

**Impact**: Medium. Better for exploratory search ("how does auth work?").

---

### 4. Context Window Expansion

**What**: Return related functions alongside matched chunks.

**Why**: A function rarely stands alone. Showing callers/callees provides crucial context.

**Implementation**:
```typescript
interface ExpandedResult {
  primary: SearchResult;        // The matched chunk
  callers: CodeChunk[];         // Functions that call this
  callees: CodeChunk[];          // Functions this calls
  imports: ImportStatement[];    // Related imports
}
```

**Impact**: Medium. Better for "understand this function" queries.

---

### 5. Type-aware Search

**What**: Index and search type signatures separately.

**Why**: "Find function returning Promise<User>" - current search can't express this.

**Implementation**:
```
1. Extract type signatures: return types, parameter types, generic types
2. Store in separate index: { signature, node_id, fqn }
3. Search accepts type filter: `search("process", { returnType: "Promise<User>" })`
```

**Impact**: Medium. Very powerful for API discovery.

---

### 6. Incremental Graph Updates

**What**: Update nodes/edges on file change instead of full reindex.

**Why**: Current approach re-indexes entire files on any change. Fine for small codebases, painful at scale.

**Implementation**:
```
1. FileWatcher detects change
2. Parse changed file → extract new nodes/edges
3. Compare with existing → compute diff
4. Update only affected nodes/edges in LanceDB
5. No need to re-embed unchanged chunks
```

**Impact**: High at scale. Critical for monorepos with 1000+ files.

---

### 7. Edge Type Weighting

**What**: Weight edge types differently in graph boosting.

**Why**: `calls` relationship is stronger signal than `imports` or `uses_type`.

**Implementation**:
```typescript
const EDGE_WEIGHTS = {
  calls: 1.0,        // Direct function call - strongest
  instantiates: 0.9, // Class instantiation
  extends: 0.8,      // Inheritance
  implements: 0.8,    // Interface implementation
  imports: 0.3,      // Module import - weakest
  uses_type: 0.4,   // Type annotation
};

// In searchWithGraphBoost:
edgeBoost = sum(EDGE_WEIGHTS[edge.kind] for edge in related_edges);
```

**Impact**: Medium. More nuanced graph boosting.

---

### 8. Semantic Chunk Boundaries

**What**: Improve chunking to respect semantic boundaries.

**Why**: Current chunks may split classes or cut mid-function.

**Implementation**:
```
1. Parse AST fully before chunking
2. Treat classes/functions as atomic chunks when possible
3. Only split large functions (> 2000 tokens) at natural boundaries
4. Track cross-chunk references (FQN in metadata)
```

**Impact**: Medium. Better chunk coherence.

---

### 9. Multi-language Index Fusion

**What**: Index same content in multiple languages (TypeScript → JavaScript).

**Why**: Users may search in JS terms but codebase is TS.

**Implementation**:
```
1. Index chunks with original language tags
2. On search, translate query concepts across language idioms
3. Example: "iterate array" (JS) ↔ "map over list" (Python)
```

**Impact**: Low-Medium. Depends on codebase language diversity.

---

### 10. Learning-to-Rank Model

**What**: Train a small LTR model for result ranking.

**Why**: Hand-tuned scoring (vector + graph) has limits.

**Implementation**:
```
Features:
- Vector similarity score
- PageRank score
- Graph distance from query symbols
- Chunk size (penalize too small/large)
- Import distance (shared modules)
- Recency (file modification time)

Labels:
- Click-through data from usage
- Or: LLM-provided relevance judgments
```

**Impact**: High for production systems. Requires training data.

---

## Priority Recommendation

| Priority | Feature | Effort | Impact |
|----------|---------|--------|--------|
| 1 | **Query Expansion** | Medium | High |
| 2 | **Hybrid Search** | Medium | High |
| 3 | **Edge Weighting** | Low | Medium |
| 4 | **Context Expansion** | Low | Medium |
| 5 | **Incremental Updates** | High | High (at scale) |
| 6 | **PageRank Reranking** | Medium | Medium |
| 7 | **Type-aware Search** | High | Medium |
| 8 | **Semantic Chunks** | High | Medium |
| 9 | **LTR Model** | Very High | High |

**Recommended next steps**:
1. Query Expansion - most impactful for natural language queries
2. Hybrid Search - fixes exact-match gap
3. Edge Weighting - quick win for graph quality

---

## Technical Debt

- [ ] ChonkieExtractor doesn't expose full AST (only chunks)
- [ ] tree-sitter-wasms has dependency issue (workaround via Chonkie)
- [ ] Edge count still low (11 edges for 129 nodes)
- [ ] No index persistence strategy (DB grows unbounded)
- [ ] Watcher re-embeds all chunks on change (should diff)

---

## Metrics to Track

- Search latency (p50, p95, p99)
- Result relevance (click-through rate or manual eval)
- Graph coverage (edges/nodes ratio over time)
- Index size growth rate
- Recall@10 on benchmark queries
