# Code Search Improvements Plan (Revised v2)

## TL;DR

> **4 Features**: Full-text BM25 upgrade, Reranking, Code section extraction, Search mode API
>
> **Effort**: Medium (1.5-2 weeks)
> **Waves**: 3 waves, max 3 concurrent tasks
> **Critical Path**: BM25 → Reranker → Section Extraction → Integration

---

## Context

### Why These 4 Features

ck-engine has 4 search modes (regex, lexical/BM25, semantic, hybrid). Your implementation needs the same flexibility for MCP agents:

| What ck-engine has | What you have now | What you need |
|-------------------|------------------|---------------|
| Tantivy BM25 full-text | Custom BM25 (basic, no persistence) | **okapibm25** (proper BM25, drop-in) |
| Cross-encoder reranking | None | **Jina AI Reranker** |
| `extract_code_sections()` | None | **Section extractor** (tree-sitter) |
| 4 explicit search modes | `exactSearch` boolean only | **Search mode enum** (regex/lexical/semantic/hybrid) |

### Current BM25 Assessment

Your `bm25.ts` is a **proper Okapi BM25 implementation** (k1=1.5, b=0.75, IDF formula correct). It's NOT broken. The main gaps:

1. **No code-aware tokenization** - `getUserName` isn't split into `get`, `user`, `name`
2. **No persistence** - rebuilt on every warm start from LanceDB data
3. **LexicalSearcher wraps it** with disk persistence but uses same basic tokenizer

### Decision: okapibm25 vs Current BM25

**Verdict: Upgrade to `okapibm25`** — it's a well-tested TypeScript BM25 with the same algorithm but cleaner API and better type safety. The real improvement is adding **code-aware tokenization** (camelCase/snake_case splitting), not the BM25 algorithm itself.

---

## Work Objectives

### Must Have
- [ ] Code-aware BM25 tokenization (camelCase: `getUserName` → `get User Name getUserName`)
- [ ] Jina AI reranking with API fallback
- [ ] Code section extraction for Top 5 languages
- [ ] Search mode enum: `regex | lexical | semantic | hybrid`

### Must NOT Have
- [ ] Streaming file search (not needed for MCP)
- [ ] Tantivy-wasm (okapibm25 is sufficient, less complexity)
- [ ] retriv (overkill — would replace Chonkies+LanceDB)
- [ ] Parallel file processing (not a bottleneck for AI agents)

---

## Execution Waves

```
Wave 1 (Foundation):
├── Task 1: Upgrade BM25 with code-aware tokenization
├── Task 2: Add search mode enum + API endpoints
└── Task 3: Integrate Jina AI Reranker

Wave 2 (Section Extraction):
├── Task 4: Section extractor core (tree-sitter)
├── Task 5: Language extractors (JS/TS, Python, Rust, Go, Java)
└── Task 6: fullSection API option

Wave 3 (Integration):
├── Task 7: Wire reranker + sections into engine
└── Task 8: Regression tests + benchmarks
```

---

## Tasks

---

### Task 1: Upgrade BM25 with Code-Aware Tokenization

**Problem**: Current BM25 treats `getUserName` as one token. ck-engine's Tantivy would find this for queries like "user" or "name". Your BM25 won't.

**What to do**:

1. Install `okapibm25`:
   ```bash
   pnpm --filter @opencode-telegram/code-search add okapibm25
   ```

2. Create `packages/code-search/src/search/tokenizer.ts` — code-aware tokenizer:
   ```typescript
   /**
    * Code-aware tokenizer for BM25.
    * Splits camelCase, PascalCase, snake_case, SCREAMING_SNAKE,
    * and dotted paths so BM25 can match sub-identifiers.
    *
    * Example: "getUserName" → ["get", "user", "name", "getusername"]
    * Example: "MAX_RETRY_COUNT" → ["max", "retry", "count", "max_retry_count"]
    * Example: "React.useState" → ["react", "usestate", "react.usestate"]
    */
   export function tokenizeCode(text: string): string[] {
     const tokens: string[] = [];

     // Step 1: Split on non-code characters (keep alphanumeric, _, ., :, /, @, $, #, -)
     const rawTokens = text
       .toLowerCase()
       .replace(/([^\w.:#\/@$_-])/g, ' ')
       .split(/\s+/)
       .filter(t => t.length > 0);

     for (const raw of rawTokens) {
       // Step 2: Split camelCase and PascalCase
       // "getUserName" → ["get", "User", "Name"]
       const camelSplit = raw.replace(/([a-z])([A-Z])/g, '$1 $2')
                              .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
                              .split(/\s+/);

       // Step 3: Split snake_case and SCREAMING_SNAKE
       // "max_retry_count" → ["max", "retry", "count"]
       const expanded: string[] = [];
       for (const part of camelSplit) {
         const snakeParts = part.split(/_+/).filter(p => p.length > 0);
         expanded.push(...snakeParts);
       }

       // Step 4: Split dotted paths
       // "react.usestate" → ["react", "usestate"]
       const dotted: string[] = [];
       for (const part of expanded) {
         const dotParts = part.split(/\./).filter(p => p.length > 0);
         dotted.push(...dotParts);
       }

       // Step 5: Add both original token and sub-tokens
       // Original: "getusername" (for exact match)
       // Sub-tokens: "get", "user", "name" (for partial match)
       tokens.push(raw.toLowerCase());
       for (const sub of dotted) {
         if (sub.toLowerCase() !== raw.toLowerCase() && sub.length > 1) {
           tokens.push(sub.toLowerCase());
         }
       }
     }

     // Step 6: Remove stop words and single-char tokens
     return tokens.filter(t => t.length > 1 && !STOP_WORDS.has(t));
   }

   const STOP_WORDS = new Set([
     'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
     'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have',
     'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
     'may', 'might', 'must', 'shall', 'can', 'need', 'it', 'its', 'this',
     'that', 'these', 'those', 'not', 'null', 'undefined', 'true', 'false',
     // Common code keywords that add noise
     'function', 'class', 'const', 'let', 'var', 'export', 'import',
     'default', 'async', 'await', 'return', 'static', 'public', 'private',
     'protected', 'interface', 'type', 'extends', 'implements', 'new',
     'try', 'catch', 'throw', 'finally',
   ]);
   ```

3. Update `packages/code-search/src/search/bm25.ts` to use `okapibm25` + code tokenizer:
   ```typescript
   import BM25, { type BMDocument, type BMConstants } from 'okapibm25';
   import { tokenizeCode } from './tokenizer.js';

   export interface BM25Result {
     index: number;
     score: number;
   }

   export class CodeBM25 {
     private documents: string[] = [];
     private docMetadata: Array<Record<string, unknown>> = [];

     /**
      * Index documents for BM25 search.
      * @param documents - Raw document content strings
      * @param metadata - Optional metadata per document (filePath, chunkId, etc.)
      */
     index(documents: string[], metadata?: Array<Record<string, unknown>>): void {
       this.documents = documents;
       this.docMetadata = metadata ?? [];
     }

     /**
      * Search documents using BM25 with code-aware tokenization.
      * @param query - Search query string
      * @param options - BM25 parameters and result limits
      */
     search(
       query: string,
       options: { k1?: number; b?: number; minScore?: number; limit?: number } = {}
     ): BM25Result[] {
       const { k1 = 1.5, b = 0.75, minScore = 0, limit = 10 } = options;

       // Tokenize query with same code-aware tokenizer
       const queryTerms = tokenizeCode(query);
       if (queryTerms.length === 0) return [];

       // Use okapibm25 for scoring
       const results = BM25(
         this.documents,
         queryTerms,
         { k1, b },
         (a, b) => b.score - a.score
       ) as BMDocument[];

       return results
         .filter(r => r.score > minScore)
         .slice(0, limit)
         .map((r, i) => ({ index: i, score: r.score }));
     }

     /** Get metadata for a result by index */
     getMetadata(index: number): Record<string, unknown> | undefined {
       return this.docMetadata[index];
     }
   }
   ```

4. Update `packages/code-search/src/search/lexical-searcher.ts`:
   - Replace `import { BM25 } from './bm25.js'` with `import { CodeBM25 } from './bm25.js'`
   - Replace `this.tokenize()` calls with `tokenizeCode()` from tokenizer.ts
   - Keep disk persistence layer unchanged

**Files to modify**:
- `packages/code-search/src/search/tokenizer.ts` (NEW)
- `packages/code-search/src/search/bm25.ts` (REWRITE)
- `packages/code-search/src/search/lexical-searcher.ts` (UPDATE import + tokenizer)
- `packages/code-search/package.json` (ADD okapibm25 dependency)

**Acceptance Criteria**:
- [ ] `tokenizeCode("getUserName")` returns `["getusername", "get", "user", "name"]`
- [ ] `tokenizeCode("MAX_RETRY_COUNT")` returns `["max_retry_count", "max", "retry", "count"]`
- [ ] `tokenizeCode("React.useState")` returns `["react.usestate", "react", "usestate"]`
- [ ] BM25 search for "user" finds chunks containing `getUserName`
- [ ] Existing lexical-searcher tests pass

**Commit**: `feat(code-search): add code-aware BM25 tokenization`

---

### Task 2: Add Search Mode Enum + API Endpoints

**Problem**: Current API has `exactSearch: boolean` toggle. ck-engine has 4 explicit modes. MCP agents need to specify what kind of search they want.

**What to do**:

1. Update `packages/code-search/src/types.ts`:
   ```typescript
   /** Search mode - determines which retrieval algorithms are used */
   export type SearchMode = 'regex' | 'lexical' | 'semantic' | 'hybrid';

   export interface SearchOptions {
     limit?: number;
     threshold?: number;
     projectPath?: string;
     filters?: SearchFilters;
     /** Search mode. Default: 'hybrid' */
     mode?: SearchMode;
     /** @deprecated Use mode: 'regex' instead */
     exactSearch?: boolean;
     /** Rerank results with cross-encoder (requires JINA_API_KEY) */
     rerank?: boolean;
     /** Reranker model to use */
     rerankModel?: string;
     /** Return containing function/class context */
     fullSection?: boolean;
     // ... existing fields remain
   }
   ```

2. Update `packages/code-search/src/engine.ts` search method:
   ```typescript
   async search(query: string, options?: Partial<SearchOptions>): Promise<SearchResult[]> {
     const mode = options?.mode ??
       (options?.exactSearch ? 'regex' : 'hybrid');  // Backward compat

     switch (mode) {
       case 'regex':
         return this.regexSearch(query, options);
       case 'lexical':
         return this.lexicalSearch(query, options);
       case 'semantic':
         return this.semanticSearch(query, options);
       case 'hybrid':
       default:
         return this.hybridSearch(query, options);
     }
   }

   private async regexSearch(query: string, options?: Partial<SearchOptions>): Promise<SearchResult[]> {
     // Use existing exactSearch logic
     const allChunks = await this.db.getAllChunksForExactSearch(projectPath, options?.filters);
     const results = exactSearch(query, allChunks, { threshold: 0.25, limit: options?.limit ?? 10, literal: true });
     // ... convert to SearchResult
   }

   private async lexicalSearch(query: string, options?: Partial<SearchOptions>): Promise<SearchResult[]> {
     // BM25-only search (no vector)
     const results = await this.lexicalSearcher.search(query, { limit: options?.limit ?? 10 });
     // ... convert to SearchResult
   }

   private async semanticSearch(query: string, options?: Partial<SearchOptions>): Promise<SearchResult[]> {
     // Vector-only search (no BM25)
     const queryEmbedding = await this.embedder.embedQuery(query);
     const results = await this.db.search(queryEmbedding, { projectPath, ...options });
     return results;
   }

   private async hybridSearch(query: string, options?: Partial<SearchOptions>): Promise<SearchResult[]> {
     // Existing hybrid logic (BM25 + vector + graph)
     // ... existing code
   }
   ```

3. Add API endpoint in `packages/code-search/src/api/routes.ts`:
   ```typescript
   // Add mode parameter to search endpoint
   router.post('/search', async (req: Request, res: Response) => {
     const { query, projectPath, options } = req.body;
     const results = await engine.search(query, {
       ...options,
       projectPath,
       mode: options?.mode ?? 'hybrid',  // Default hybrid
     });
     res.json({ success: true, results });
   });

   // Add dedicated mode endpoints
   router.post('/search/regex', ...);     // mode: 'regex'
   router.post('/search/lexical', ...);   // mode: 'lexical'
   router.post('/search/semantic', ...);   // mode: 'semantic'
   ```

4. Update MCP server tools in `packages/mcp-server/src/index.ts`:
   - Add `mode` parameter to `semantic_search` tool
   - Add `regex_search` tool
   - Add `lexical_search` tool

**Files to modify**:
- `packages/code-search/src/types.ts` (UPDATE SearchMode, SearchOptions)
- `packages/code-search/src/engine.ts` (ADD mode switch)
- `packages/code-search/src/api/routes.ts` (ADD mode endpoints)
- `packages/mcp-server/src/index.ts` (ADD MCP tools)

**Acceptance Criteria**:
- [ ] `POST /search` with `mode: "lexical"` returns BM25-only results
- [ ] `POST /search` with `mode: "semantic"` returns vector-only results
- [ ] `POST /search` with `mode: "regex"` returns exact match results
- [ ] `POST /search` with `mode: "hybrid"` returns combined results (default)
- [ ] Backward compat: `exactSearch: true` → `mode: "regex"`

**Commit**: `feat(code-search): add explicit search modes (regex/lexical/semantic/hybrid)`

---

### Task 3: Integrate Jina AI Reranker

**What to do**:

1. Create `packages/code-search/src/search/reranker.ts`:
   ```typescript
   export interface RerankerConfig {
     apiKey: string;
     model?: string;       // default: 'jina-reranker-v2-base-multilingual'
     baseUrl?: string;    // default: 'https://api.jina.ai/v1/rerank'
     maxDocuments?: number; // default: 50 (cost control)
     timeoutMs?: number;  // default: 10000
   }

   export interface RerankResult {
     index: number;          // Original index in input array
     relevanceScore: number; // 0-1 normalized score
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

         const data = await response.json();

         return (data.results ?? []).map((r: any) => ({
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

     /** Fallback: return original order with equal scores */
     private fallbackResults(count: number): RerankResult[] {
       return Array.from({ length: count }, (_, i) => ({
         index: i,
         relevanceScore: 1 - (i / count), // Decreasing scores
         document: { text: '' },
       }));
     }

     /** Apply reranking to SearchResult[] */
     async rerankSearchResults(
       query: string,
       results: SearchResult[],
       topN?: number
     ): Promise<SearchResult[]> {
       if (results.length === 0) return results;

       const documents = results.map(r => r.chunk.content);
       const rerankResults = await this.rerank(query, documents, topN);

       // Reorder results based on reranker
       const reranked = rerankResults
         .map(rr => {
           const original = results[rr.index];
           if (!original) return null;
           return {
             ...original,
             score: rr.relevanceScore,
             // Keep original score as metadata
             metadata: { ...original, originalScore: original.score },
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
   ```

2. Update `packages/code-search/src/types.ts`:
   ```typescript
   export interface SearchOptions {
     // ... existing
     /** Rerank results with cross-encoder (requires JINA_API_KEY) */
     rerank?: boolean;
     /** Reranker model to use */
     rerankModel?: string;
   }
   ```

3. Update `packages/code-search/src/engine.ts` to use reranker:
   ```typescript
   private reranker: Reranker | null = null;

   constructor(config: Partial<Config> = {}) {
     // ... existing
     const jinaApiKey = config.reranker?.apiKey ?? process.env.JINA_API_KEY;
     if (jinaApiKey) {
       this.reranker = new Reranker({
         apiKey: jinaApiKey,
         model: config.reranker?.model,
       });
     }
   }

   async search(query: string, options?: Partial<SearchOptions>): Promise<SearchResult[]> {
     // ... existing search logic ...

     // Apply reranking if requested and available
     if (options?.rerank && this.reranker) {
       results = await this.reranker.rerankSearchResults(query, results, options?.limit);
     }

     return results.slice(0, options?.limit ?? 10);
   }
   ```

4. Add `JINA_API_KEY` to `.env.example`

**Files to create/modify**:
- `packages/code-search/src/search/reranker.ts` (NEW)
- `packages/code-search/src/types.ts` (UPDATE SearchOptions)
- `packages/code-search/src/engine.ts` (INTEGRATE reranker)
- `.env.example` (ADD JINA_API_KEY)

**Acceptance Criteria**:
- [ ] `rerank: true` with valid JINA_API_KEY returns reranked results
- [ ] Invalid/missing API key → graceful fallback, search completes
- [ ] Only top 50 documents sent to reranker (cost control)
- [ ] 10s timeout on API call → fallback

**Jina API Reference**:
```
POST https://api.jina.ai/v1/rerank
Headers: Authorization: Bearer {JINA_API_KEY}
Body: { model, query, documents, top_n, return_documents }
Response: { results: [{ index, relevance_score, document: { text } }] }
```

**Commit**: `feat(code-search): integrate Jina AI reranker with fallback`

---

### Task 4: Code Section Extraction Core

**What to do**:

1. Create `packages/code-search/src/search/section-extractor.ts`:
   ```typescript
   import Parser from 'web-tree-sitter';

   export interface CodeSection {
     startLine: number;
     endLine: number;
     content: string;
     type: 'function' | 'class' | 'method' | 'module';
     name: string;  // Function/class name
   }

   /** File extension → tree-sitter language name */
   const EXT_TO_LANG: Record<string, string> = {
     '.js': 'javascript', '.jsx': 'javascript',
     '.ts': 'typescript', '.tsx': 'tsx',
     '.py': 'python',
     '.rs': 'rust',
     '.go': 'go',
     '.java': 'java',
   };

   export class SectionExtractor {
     private parser: Parser | null = null;
     private languages: Map<string, Parser.Language> = new Map();
     private initPromise: Promise<void> | null = null;

     async initialize(): Promise<void> {
       if (this.initPromise) return this.initPromise;

       this.initPromise = this._init();
       return this.initPromise;
     }

     private async _init(): Promise<void> {
       await Parser.init();
       this.parser = new Parser();
     }

     private async getLanguage(langName: string): Promise<Parser.Language | null> {
       if (this.languages.has(langName)) {
         return this.languages.get(langName)!;
       }

       try {
         // Load grammar from tree-sitter-wasms package
         const lang = await Parser.Language.load(
           `node_modules/tree-sitter-wasms/langs/${langName}.wasm`
         );
         this.languages.set(langName, lang);
         return lang;
       } catch {
         console.warn(`[SectionExtractor] No grammar for ${langName}`);
         return null;
       }
     }

     /**
      * Find the containing function/class for a given line.
      * Returns null if line is at module scope (no containing section).
      */
     async extractContainingSection(
       filePath: string,
       lineNumber: number,
       content?: string
     ): Promise<CodeSection | null> {
       await this.initialize();

       const ext = this.getExtension(filePath);
       const langName = EXT_TO_LANG[ext];
       if (!langName) return null;

       const lang = await this.getLanguage(langName);
       if (!lang || !this.parser) return null;

       // Read file if content not provided
       const fileContent = content ?? await this.readFile(filePath);
       if (!fileContent) return null;

       this.parser.setLanguage(lang);
       const tree = this.parser.parse(fileContent);

       // Walk the tree to find the deepest node containing the line
       const section = this.findContainingNode(tree.rootNode, lineNumber, fileContent);
       tree.delete();

       return section;
     }

     private findContainingNode(
       node: Parser.SyntaxNode,
       targetLine: number,
       content: string
     ): CodeSection | null {
       // Node types that represent code sections
       const SECTION_TYPES = new Set([
         'function_declaration', 'function_definition',
         'method_definition', 'arrow_function',
         'class_declaration', 'class_definition',
         'impl_item',  // Rust
         'function_item', // Rust
         'declaration',  // Go
         'method_declaration', // Java, Go
         'constructor_declaration', // Java
       ]);

       let bestMatch: CodeSection | null = null;

       for (let i = 0; i < node.childCount; i++) {
         const child = node.child(i);
         if (!child) continue;

         const startLine = child.startPosition.row + 1; // 1-indexed
         const endLine = child.endPosition.row + 1;

         // Check if this node contains our target line
         if (targetLine >= startLine && targetLine <= endLine) {
           // If it's a section type, this is a candidate
           if (SECTION_TYPES.has(child.type)) {
             // Prefer the deepest (most specific) containing section
             const childSection = this.findContainingNode(child, targetLine, content);
             if (childSection) {
               bestMatch = childSection;
             } else {
               // This node is the deepest section containing the line
               const sectionContent = this.extractContent(content, startLine, endLine);
               bestMatch = {
                 startLine,
                 endLine,
                 content: sectionContent,
                 type: this.classifyType(child.type),
                 name: this.extractName(child, content),
               };
             }
           } else {
             // Not a section type, recurse deeper
             const deeper = this.findContainingNode(child, targetLine, content);
             if (deeper) bestMatch = deeper;
           }
         }
       }

       return bestMatch;
     }

     private extractContent(content: string, startLine: number, endLine: number): string {
       const lines = content.split('\n');
       return lines.slice(startLine - 1, endLine).join('\n');
     }

     private classifyType(nodeType: string): CodeSection['type'] {
       if (nodeType.includes('class')) return 'class';
       if (nodeType.includes('method') || nodeType.includes('constructor')) return 'method';
       return 'function';
     }

     private extractName(node: Parser.SyntaxNode, content: string): string {
       // Try to find the name node (identifier) within the function/class
       for (let i = 0; i < node.childCount; i++) {
         const child = node.child(i);
         if (child?.type === 'identifier' || child?.type === 'name') {
           return child.text;
         }
       }
       return 'anonymous';
     }

     private getExtension(filePath: string): string {
       const match = filePath.match(/\.[^.]+$/);
       return match ? match[0] : '';
     }

     private async readFile(filePath: string): Promise<string | null> {
       try {
         const fs = await import('fs/promises');
         return await fs.readFile(filePath, 'utf-8');
       } catch {
         return null;
       }
     }
   }
   ```

**Files to create**:
- `packages/code-search/src/search/section-extractor.ts` (NEW)

**Acceptance Criteria**:
- [ ] `extractContainingSection(file, 10)` returns containing function
- [ ] Module-level code returns null
- [ ] Nested function: returns innermost containing function
- [ ] Supports JS/TS, Python, Rust, Go, Java

**Commit**: `feat(code-search): add code section extractor with tree-sitter`

---

### Task 5: Language-Specific Extractors

**What to do**:

Extend `section-extractor.ts` with language-specific node types:

```typescript
// Add to SECTION_TYPES in findContainingNode():
const LANG_SECTION_TYPES: Record<string, Set<string>> = {
  javascript: new Set([
    'function_declaration', 'function_expression',
    'arrow_function', 'method_definition',
    'class_declaration', 'class_expression',
  ]),
  typescript: new Set([
    'function_declaration', 'function_expression',
    'arrow_function', 'method_definition',
    'class_declaration', 'interface_declaration',
    'type_alias_declaration',
  ]),
  tsx: new Set([
    'function_declaration', 'function_expression',
    'arrow_function', 'method_definition',
    'class_declaration',
  ]),
  python: new Set([
    'function_definition',  // def foo():
    'class_definition',     // class Foo:
  ]),
  rust: new Set([
    'function_item',        // fn foo()
    'impl_item',            // impl Type { }
    'struct_item',          // struct Foo
    'enum_item',            // enum Bar
    'trait_item',           // trait Baz
  ]),
  go: new Set([
    'function_declaration',  // func foo()
    'method_declaration',    // func (t T) foo()
    'type_declaration',      // type Foo struct
  ]),
  java: new Set([
    'class_declaration',
    'method_declaration',
    'constructor_declaration',
    'interface_declaration',
  ]),
};
```

Update `findContainingNode` to use `LANG_SECTION_TYPES[langName]` when available, fall back to base `SECTION_TYPES`.

**Files to modify**:
- `packages/code-search/src/search/section-extractor.ts` (UPDATE)

**Acceptance Criteria**:
- [ ] JS: `function foo() {}` detected, arrow functions detected
- [ ] Python: `def foo():` detected, `class Foo:` detected
- [ ] Rust: `fn foo()` detected, `impl Type` detected
- [ ] Go: `func foo()` detected, methods with receivers detected
- [ ] Java: `class Foo` detected, methods detected

**Commit**: (with Task 4)

---

### Task 6: fullSection API Option

**What to do**:

1. Update `packages/code-search/src/types.ts`:
   ```typescript
   export interface SearchResult {
     chunk: CodeChunk;
     score: number;
     query: string;
     highlights: string[];
     /** Containing function/class context (when fullSection=true) */
     sectionContext?: CodeSection;
   }
   ```

2. Update `packages/code-search/src/engine.ts`:
   ```typescript
   private sectionExtractor: SectionExtractor | null = null;

   constructor(config) {
     this.sectionExtractor = new SectionExtractor();
   }

   async search(query: string, options?: Partial<SearchOptions>): Promise<SearchResult[]> {
     // ... existing search logic ...

     // Apply section extraction if requested
     if (options?.fullSection && this.sectionExtractor) {
       const enriched = await Promise.all(
         results.map(async (result) => {
           try {
             const section = await this.sectionExtractor.extractContainingSection(
               result.chunk.filePath,
               result.chunk.startLine
             );
             return { ...result, sectionContext: section ?? undefined };
           } catch {
             return result;
           }
         })
       );
       results = enriched;
     }

     return results;
   }
   ```

3. Update API routes to expose `fullSection` and `rerank` options.

**Files to modify**:
- `packages/code-search/src/types.ts` (UPDATE SearchResult)
- `packages/code-search/src/engine.ts` (INTEGRATE section extractor)
- `packages/code-search/src/api/routes.ts` (EXPOSE options)

**Acceptance Criteria**:
- [ ] `fullSection: true` returns `sectionContext` with full function
- [ ] `fullSection: false` (default) returns no `sectionContext`
- [ ] API accepts `fullSection` and `rerank` parameters

**Commit**: `feat(code-search): add fullSection option with section context`

---

### Task 7: Wire Reranker + Sections into Engine

**What to do**:

Integrate all features into the engine search flow:

```typescript
async search(query: string, options?: Partial<SearchOptions>): Promise<SearchResult[]> {
  const mode = options?.mode ?? (options?.exactSearch ? 'regex' : 'hybrid');

  // Step 1: Retrieve results based on mode
  let results: SearchResult[];
  switch (mode) {
    case 'regex':    results = await this.regexSearch(query, options); break;
    case 'lexical':  results = await this.lexicalSearch(query, options); break;
    case 'semantic':  results = await this.semanticSearch(query, options); break;
    case 'hybrid':
    default:          results = await this.hybridSearch(query, options); break;
  }

  // Step 2: Apply reranking (if requested and available)
  if (options?.rerank && this.reranker && results.length > 0) {
    results = await this.reranker.rerankSearchResults(query, results, options?.limit);
  }

  // Step 3: Apply section extraction (if requested)
  if (options?.fullSection && this.sectionExtractor) {
    results = await this.enrichWithSections(results);
  }

  return results.slice(0, options?.limit ?? 10);
}
```

**Files to modify**:
- `packages/code-search/src/engine.ts` (FINAL integration)

**Acceptance Criteria**:
- [ ] Search mode routing works for all 4 modes
- [ ] Reranking applied after retrieval, before section extraction
- [ ] Section extraction doesn't break when reranking disabled
- [ ] All features work independently and together

**Commit**: `feat(code-search): integrate all search improvements`

---

### Task 8: Regression Tests + Benchmarks

**What to do**:

1. Create test file `packages/code-search/test/search-modes.test.ts`:
   - Test each search mode returns results
   - Test `exactSearch: true` backward compat
   - Test mode parameter validation

2. Create test file `packages/code-search/test/reranker.test.ts`:
   - Test reranker with mocked API
   - Test fallback on API failure
   - Test cost control (max 50 documents)

3. Create test file `packages/code-search/test/section-extractor.test.ts`:
   - Test JS function extraction
   - Test Python class extraction
   - Test module-level code returns null

4. Create test file `packages/code-search/test/tokenizer.test.ts`:
   - Test camelCase splitting
   - Test snake_case splitting
   - Test dotted path splitting

5. Run full suite: `pnpm test && pnpm typecheck`

**Files to create**:
- `packages/code-search/test/search-modes.test.ts`
- `packages/code-search/test/reranker.test.ts`
- `packages/code-search/test/section-extractor.test.ts`
- `packages/code-search/test/tokenizer.test.ts`

**Acceptance Criteria**:
- [ ] All tests pass
- [ ] Typecheck clean
- [ ] No regression in existing tests

**Commit**: `test(code-search): add tests for search improvements`

---

## Final Checklist

- [ ] Code-aware BM25 tokenization working
- [ ] 4 search modes (regex/lexical/semantic/hybrid) exposed via API
- [ ] Jina AI reranker integrated with fallback
- [ ] Section extraction returns containing function
- [ ] `fullSection` and `rerank` options in API
- [ ] All tests pass
- [ ] No breaking changes (additive only)

## Verification

```bash
pnpm --filter @opencode-telegram/code-search test
pnpm --filter @opencode-telegram/code-search typecheck
```
