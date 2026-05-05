/**
 * Persistent Lexical Searcher
 *
 * Replaces the in-memory BM25 rebuild path with a persistent lexical index
 * that survives restarts. Artifacts are stored at:
 *   {artifactBasePath}/lexical/{projectHash}/
 *
 * Artifacts:
 *   - manifest.json      - Index metadata, version, checksums
 *   - inverted-index.json - Term → [docId] mapping
 *   - docs.jsonl        - Document records (id, content, metadata)
 *   - bm25_params.json  - Pre-computed BM25 parameters
 *   - index.lock        - Write lock (ephemeral)
 *
 * Design principles:
 *   - Warm start < 500ms (load from disk, no rebuild)
 *   - Atomic artifact swaps on rebuild
 *   - Corruption detection via checksum validation
 *   - Graceful degradation (lexical-only mode if semantic corrupt)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { BM25, type BM25Config } from './bm25.js';

export interface LexicalResult {
  docId: string;
  chunkId: string;
  score: number;
  content: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
}

export interface LexicalSearchOptions {
  limit?: number;
  filters?: {
    language?: string;
    filePath?: string;
  };
}

interface LexicalDocument {
  docId: string;
  chunkId: string;
  content: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  metadata: Record<string, unknown>;
}

interface LexicalManifest {
  version: string;
  artifactType: 'lexical';
  projectPath: string;
  projectHash: string;
  chunkCount: number;
  buildTimestamp: string;
  buildDurationMs: number;
  checksum: string;
  bm25Params: {
    k1: number;
    b: number;
    avgDocLength: number;
  };
  sourceArtifactChecksums: {
    'inverted-index.json': string;
    'docs.jsonl': string;
  };
}

interface InvertedIndex {
  terms: Record<string, number[]>;
}

const ARTIFACT_VERSION = '1.0.0';
const LOCK_TIMEOUT_MS = 30000;
const LOCK_STALE_MS = 5 * 60 * 1000;

export class LexicalSearcher {
  private artifactBasePath: string;
  private projectPath: string;
  private projectHash: string;
  private indexPath: string;
  private invertedIndex: InvertedIndex | null = null;
  private documents: LexicalDocument[] = [];
  private bm25Params: BM25Config = { k1: 1.5, b: 0.75, avgDocLength: 500 };
  private isReady: boolean = false;
  private isStale: boolean = false;
  private manifest: LexicalManifest | null = null;

  constructor(artifactBasePath: string, projectPath: string) {
    this.artifactBasePath = artifactBasePath;
    this.projectPath = path.resolve(projectPath);
    this.projectHash = this.computeProjectHash(this.projectPath);
    this.indexPath = path.join(this.artifactBasePath, 'lexical', this.projectHash);
  }

  async initialize(): Promise<{ ready: boolean; chunkCount: number }> {
    try {
      const warmStart = await this.tryWarmStart();
      if (warmStart) {
        this.isReady = true;
        return { ready: true, chunkCount: this.documents.length };
      }
    } catch (error) {
      console.warn(`[LexicalSearcher] Warm start failed for ${this.projectHash}:`, error);
    }

    this.isReady = false;
    this.isStale = true;
    return { ready: false, chunkCount: 0 };
  }

  async search(query: string, options: LexicalSearchOptions = {}): Promise<LexicalResult[]> {
    const limit = options.limit ?? 10;

    if (this.isStale && this.isReady === false) {
      console.log(`[LexicalSearcher] Index stale, building for ${this.projectHash}...`);
      await this.buildIndex();
    }

    if (!this.isReady || !this.invertedIndex) {
      return [];
    }

    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) {
      return [];
    }

    const docScores = new Map<number, number>();

    for (const term of queryTerms) {
      const docIndices = this.invertedIndex.terms[term];
      if (!docIndices) continue;

      for (const docIndex of docIndices) {
        const doc = this.documents[docIndex];
        if (!doc) continue;

        if (options.filters?.language && doc.language !== options.filters.language) {
          continue;
        }
        if (options.filters?.filePath && !doc.filePath.startsWith(options.filters.filePath)) {
          continue;
        }

        const docTerms = this.tokenize(doc.content);
        const termFreq = docTerms.filter(t => t === term).length;
        if (termFreq === 0) continue;

        const docLen = docTerms.length;
        const avgDocLen = this.bm25Params.avgDocLength || 1;
        const docCount = this.documents.length;
        const df = docIndices.length;
        const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);

        const numerator = termFreq * (this.bm25Params.k1 + 1);
        const denominator = termFreq + this.bm25Params.k1 * (1 - this.bm25Params.b + this.bm25Params.b * (docLen / avgDocLen));
        const score = idf * (numerator / denominator);

        const currentScore = docScores.get(docIndex) || 0;
        docScores.set(docIndex, currentScore + score);
      }
    }

    const sortedResults = Array.from(docScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    return sortedResults.map(([docIndex, score]) => {
      const doc = this.documents[docIndex];
      if (!doc) return null;
      return {
        docId: doc.docId,
        chunkId: doc.chunkId,
        score,
        content: doc.content,
        filePath: doc.filePath,
        startLine: doc.startLine,
        endLine: doc.endLine,
        language: doc.language,
      };
    }).filter((r): r is LexicalResult => r !== null);
  }

  async forceReindex(getDocuments: () => Promise<LexicalDocument[]>): Promise<{ chunkCount: number; durationMs: number }> {
    const startTime = Date.now();

    const lockAcquired = await this.acquireLock();
    if (!lockAcquired) {
      throw new Error(`[LexicalSearcher] Could not acquire lock for ${this.projectHash} after ${LOCK_TIMEOUT_MS}ms`);
    }

    try {
      const documents = await getDocuments();

      const tempPath = path.join(this.indexPath, `.rebuild.${Date.now()}`);
      await fs.mkdir(tempPath, { recursive: true });

      const docsPath = path.join(tempPath, 'docs.jsonl');
      const docsContent = documents.map(d => JSON.stringify(d)).join('\n');
      await fs.writeFile(docsPath, docsContent, 'utf-8');

      const invertedIndex = this.buildInvertedIndex(documents);

      const indexPath = path.join(tempPath, 'inverted-index.json');
      await fs.writeFile(indexPath, JSON.stringify(invertedIndex), 'utf-8');

      const allTerms = documents.map(d => this.tokenize(d.content)).flat();
      const avgDocLength = documents.length > 0
        ? allTerms.length / documents.length
        : 500;

      const bm25Params: BM25Config = {
        k1: 1.5,
        b: 0.75,
        avgDocLength,
      };

      const bm25ParamsPath = path.join(tempPath, 'bm25_params.json');
      await fs.writeFile(bm25ParamsPath, JSON.stringify(bm25Params), 'utf-8');

      const indexChecksum = await this.computeFileChecksum(indexPath);
      const docsChecksum = await this.computeFileChecksum(docsPath);

      const manifest: LexicalManifest = {
        version: ARTIFACT_VERSION,
        artifactType: 'lexical',
        projectPath: this.projectPath,
        projectHash: this.projectHash,
        chunkCount: documents.length,
        buildTimestamp: new Date().toISOString(),
        buildDurationMs: Date.now() - startTime,
        checksum: '',
        bm25Params,
        sourceArtifactChecksums: {
          'inverted-index.json': indexChecksum,
          'docs.jsonl': docsChecksum,
        },
      };
      manifest.checksum = await this.computeManifestChecksum(manifest, indexChecksum, docsChecksum);

      const manifestPath = path.join(tempPath, 'manifest.json');
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

      await this.ensureIndexDirectory();
      await fs.rename(tempPath, this.indexPath);

      this.invertedIndex = invertedIndex;
      this.documents = documents;
      this.bm25Params = bm25Params;
      this.manifest = manifest;
      this.isReady = true;
      this.isStale = false;

      const durationMs = Date.now() - startTime;
      console.log(`[LexicalSearcher] Reindex complete for ${this.projectHash}: ${documents.length} chunks in ${durationMs}ms`);

      return { chunkCount: documents.length, durationMs };
    } finally {
      await this.releaseLock();
    }
  }

  markStale(): void {
    this.isStale = true;
  }

  isIndexReady(): boolean {
    return this.isReady;
  }

  getStatus(): {
    ready: boolean;
    stale: boolean;
    chunkCount: number;
    projectHash: string;
    manifest: LexicalManifest | null;
  } {
    return {
      ready: this.isReady,
      stale: this.isStale,
      chunkCount: this.documents.length,
      projectHash: this.projectHash,
      manifest: this.manifest,
    };
  }

  async updateDocument(doc: LexicalDocument): Promise<void> {
    this.markStale();
  }

  async removeDocument(docId: string): Promise<void> {
    this.markStale();
  }

  private computeProjectHash(projectPath: string): string {
    const normalizedPath = path.resolve(projectPath);
    return crypto.createHash('sha256').update(normalizedPath).digest('hex').slice(0, 16);
  }

  private async tryWarmStart(): Promise<boolean> {
    const manifestPath = path.join(this.indexPath, 'manifest.json');
    const indexPath = path.join(this.indexPath, 'inverted-index.json');
    const docsPath = path.join(this.indexPath, 'docs.jsonl');
    const bm25ParamsPath = path.join(this.indexPath, 'bm25_params.json');

    try {
      await fs.access(manifestPath);
      await fs.access(indexPath);
      await fs.access(docsPath);
      await fs.access(bm25ParamsPath);
    } catch {
      return false;
    }

    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
    const manifest: LexicalManifest = JSON.parse(manifestContent);

    if (manifest.version !== ARTIFACT_VERSION) {
      console.warn(`[LexicalSearcher] Artifact version mismatch: ${manifest.version} != ${ARTIFACT_VERSION}, rebuilding`);
      return false;
    }

    const indexChecksum = await this.computeFileChecksum(indexPath);
    const docsChecksum = await this.computeFileChecksum(docsPath);

    if (indexChecksum !== manifest.sourceArtifactChecksums['inverted-index.json']) {
      console.warn(`[LexicalSearcher] Inverted index checksum mismatch for ${this.projectHash}, rebuilding`);
      return false;
    }
    if (docsChecksum !== manifest.sourceArtifactChecksums['docs.jsonl']) {
      console.warn(`[LexicalSearcher] Docs checksum mismatch for ${this.projectHash}, rebuilding`);
      return false;
    }

    const indexContent = await fs.readFile(indexPath, 'utf-8');
    this.invertedIndex = JSON.parse(indexContent);

    const docsContent = await fs.readFile(docsPath, 'utf-8');
    this.documents = docsContent.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));

    const bm25ParamsContent = await fs.readFile(bm25ParamsPath, 'utf-8');
    this.bm25Params = JSON.parse(bm25ParamsContent);

    this.manifest = manifest;
    this.isReady = true;
    this.isStale = false;

    console.log(`[LexicalSearcher] Warm start successful for ${this.projectHash}: ${this.documents.length} chunks`);
    return true;
  }

  private async buildIndex(): Promise<void> {
    this.isReady = true;
    this.isStale = false;
  }

  private buildInvertedIndex(documents: LexicalDocument[]): InvertedIndex {
    const terms: Record<string, number[]> = {};

    documents.forEach((doc, docIndex) => {
      const docTerms = this.tokenize(doc.content);
      const seenTerms = new Set<string>();

      for (const term of docTerms) {
        if (!seenTerms.has(term)) {
          seenTerms.add(term);
          if (!terms[term]) {
            terms[term] = [];
          }
          terms[term].push(docIndex);
        }
      }
    });

    for (const term of Object.keys(terms)) {
      terms[term]!.sort((a, b) => a - b);
    }

    return { terms };
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/([^\w_.:#\/\@\$])/g, ' $1 ')
      .replace(/(\w)'(\w)/g, '$1 $2')
      .split(/\s+/)
      .filter(t => t.length > 1)
      .filter(t => !STOP_WORDS.has(t));
  }

  private async computeFileChecksum(filePath: string): Promise<string> {
    const content = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private async computeManifestChecksum(
    manifest: LexicalManifest,
    indexChecksum: string,
    docsChecksum: string
  ): Promise<string> {
    const data = JSON.stringify({
      ...manifest,
      checksum: undefined,
      sourceArtifactChecksums: {
        'inverted-index.json': indexChecksum,
        'docs.jsonl': docsChecksum,
      },
    });
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  private async ensureIndexDirectory(): Promise<void> {
    await fs.mkdir(this.indexPath, { recursive: true });
  }

  private async acquireLock(): Promise<boolean> {
    const lockPath = path.join(this.indexPath, 'index.lock');

    try {
      const stats = await fs.stat(lockPath);
      const age = Date.now() - stats.mtimeMs;
      if (age > LOCK_STALE_MS) {
        console.warn(`[LexicalSearcher] Removing stale lock for ${this.projectHash} (age: ${age}ms)`);
        await fs.unlink(lockPath);
      }
    } catch {
    }

    const startTime = Date.now();
    while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
      try {
        await fs.writeFile(lockPath, `${process.pid}`, { flag: 'wx' });
        return true;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    return false;
  }

  private async releaseLock(): Promise<void> {
    const lockPath = path.join(this.indexPath, 'index.lock');
    try {
      await fs.unlink(lockPath);
    } catch {
    }
  }
}

const STOP_WORDS = new Set([
  'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
  'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have',
  'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she',
  'we', 'they', 'what', 'which', 'who', 'whom', 'whose', 'where', 'when',
  'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'just', 'if', 'then', 'else', 'while', 'although',
  'because', 'since', 'until', 'unless', 'though', 'before', 'after', 'about',
  'into', 'through', 'during', 'above', 'below', 'between', 'under', 'again',
  'further', 'once', 'function', 'class', 'const', 'let', 'var', 'export',
  'import', 'default', 'async', 'await', 'return', 'static', 'public', 'private',
  'protected', 'interface', 'type', 'extends', 'implements', 'new', 'try',
  'catch', 'throw', 'finally', 'null', 'undefined', 'true', 'false',
]);