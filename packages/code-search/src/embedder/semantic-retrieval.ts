import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import type { CodeChunk } from '../types.js';
import { MultiProviderEmbedder, type ProviderConfig } from './jina-embedder.js';

export interface SemanticManifest {
  version: string;
  artifactType: 'semantic';
  projectPath: string;
  projectHash: string;
  chunkCount: number;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimension: number;
  buildTimestamp: string;
  buildDurationMs: number;
  checksum: string;
  sourceArtifactChecksums: {
    chunks: string;
    vectors: string;
  };
}

export interface SemanticArtifact {
  manifest: SemanticManifest;
  chunks: CodeChunk[];
  vectors: number[][];
}

export class SemanticIndex {
  private embedder: MultiProviderEmbedder;
  private basePath: string;
  private projectHash: string = '';
  private cachedVectors: number[][] | null = null;
  private cachedChunks: CodeChunk[] | null = null;
  private manifest: SemanticManifest | null = null;

  constructor(embedder: MultiProviderEmbedder, basePath: string) {
    this.embedder = embedder;
    this.basePath = basePath;
  }

  private async computeFileChecksum(filePath: string): Promise<string> {
    const content = await fs.readFile(filePath);
    return createHash('sha256').update(content).digest('hex');
  }

  private async computeVectorsChecksum(vectors: number[][]): Promise<string> {
    const flat = vectors.flat();
    return createHash('sha256').update(Buffer.from(new Float32Array(flat).buffer)).digest('hex');
  }

  async computeProjectHash(projectPath: string): Promise<string> {
    const normalized = projectPath.replace(/\/+$/, '');
    return createHash('sha256').update(normalized).digest('hex');
  }

  getSemanticPath(projectHash: string): string {
    return join(this.basePath, 'semantic', projectHash);
  }

  async load(projectPath: string): Promise<boolean> {
    this.projectHash = await this.computeProjectHash(projectPath);
    const semanticPath = this.getSemanticPath(this.projectHash);
    const manifestPath = join(semanticPath, 'manifest.json');

    try {
      const manifestContent = await fs.readFile(manifestPath, 'utf-8');
      this.manifest = JSON.parse(manifestContent) as SemanticManifest;

      if (this.manifest.embeddingDimension !== this.embedder.dimensions) {
        console.warn(`[SemanticIndex] Dimension mismatch: manifest has ${this.manifest.embeddingDimension}, current uses ${this.embedder.dimensions}. Need rebuild.`);
        return false;
      }

      const chunksPath = join(semanticPath, 'chunks.json');
      const chunksContent = await fs.readFile(chunksPath, 'utf-8');
      this.cachedChunks = JSON.parse(chunksContent);

      const vectorsPath = join(semanticPath, 'vectors.bfs');
      const vectorsBuffer = await fs.readFile(vectorsPath);
      const vectorCount = this.manifest.chunkCount;
      const dim = this.manifest.embeddingDimension;
      const vectors: number[][] = [];
      for (let i = 0; i < vectorCount; i++) {
        const start = i * dim * 4;
        const slice = vectorsBuffer.slice(start, start + dim * 4);
        const floats = new Float32Array(slice.buffer, slice.byteOffset, dim);
        vectors.push(Array.from(floats));
      }

      this.cachedVectors = vectors;
      console.log(`[SemanticIndex] Loaded ${vectorCount} vectors from disk for ${projectPath}`);
      return true;
    } catch (err) {
      console.log(`[SemanticIndex] No existing artifacts found for ${projectPath}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async build(chunks: CodeChunk[], projectPath: string): Promise<void> {
    if (!this.projectHash) {
      this.projectHash = await this.computeProjectHash(projectPath);
    }

    const semanticPath = this.getSemanticPath(this.projectHash);
    await fs.mkdir(semanticPath, { recursive: true });

    console.log(`[SemanticIndex] Building semantic index for ${chunks.length} chunks...`);
    const startTime = Date.now();

    const texts = chunks.map(c => c.content.trim() === '' ? ' ' : c.content);
    const vectors: number[][] = [];

    const batchSize = 64;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchVectors = await this.embedder.embedBatch(batch);
      vectors.push(...batchVectors);
      if (i + batchSize < texts.length) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    const chunksPath = join(semanticPath, 'chunks.json');
    await fs.writeFile(chunksPath, JSON.stringify(chunks));

    const vectorsPath = join(semanticPath, 'vectors.bfs');
    const flatVectors = vectors.flat();
    const buffer = Buffer.from(new Float32Array(flatVectors).buffer);
    await fs.writeFile(vectorsPath, buffer);

    const chunksChecksum = await this.computeFileChecksum(chunksPath);
    const vectorsChecksum = await this.computeFileChecksum(vectorsPath);
    const durationMs = Date.now() - startTime;

    this.manifest = {
      version: '1.0.0',
      artifactType: 'semantic',
      projectPath,
      projectHash: this.projectHash,
      chunkCount: chunks.length,
      embeddingProvider: this.embedder.providerName,
      embeddingModel: 'jina-embeddings-v3',
      embeddingDimension: this.embedder.dimensions,
      buildTimestamp: new Date().toISOString(),
      buildDurationMs: durationMs,
      checksum: createHash('sha256').update(chunksChecksum + vectorsChecksum).digest('hex'),
      sourceArtifactChecksums: {
        chunks: chunksChecksum,
        vectors: vectorsChecksum,
      },
    };

    const manifestPath = join(semanticPath, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify(this.manifest, null, 2));

    this.cachedChunks = chunks;
    this.cachedVectors = vectors;
    console.log(`[SemanticIndex] Built semantic index in ${durationMs}ms: ${chunks.length} chunks, ${vectors.length} vectors`);
  }

  getVectors(): number[][] | null {
    return this.cachedVectors;
  }

  getChunks(): CodeChunk[] | null {
    return this.cachedChunks;
  }

  getManifest(): SemanticManifest | null {
    return this.manifest;
  }

  async search(query: string, topK: number = 10): Promise<Array<{ chunk: CodeChunk; score: number }>> {
    if (!this.cachedVectors || !this.cachedChunks) {
      throw new Error('[SemanticIndex] Index not loaded. Call load() first.');
    }

    const queryVector = await this.embedder.embedQueryWithFallback(query);
    const scores: Array<{ index: number; score: number }> = [];

    for (let i = 0; i < this.cachedVectors.length; i++) {
      const vec = this.cachedVectors[i];
      if (!vec) continue;
      let dotProduct = 0;
      for (let j = 0; j < queryVector.length; j++) {
        dotProduct += (queryVector[j] ?? 0) * (vec[j] ?? 0);
      }
      scores.push({ index: i, score: dotProduct });
    }

    scores.sort((a, b) => b.score - a.score);
    const results: Array<{ chunk: CodeChunk; score: number }> = [];

    for (let i = 0; i < Math.min(topK, scores.length); i++) {
      const entry = scores[i];
      if (!entry) continue;
      const { index, score } = entry;
      const chunk = this.cachedChunks[index];
      if (chunk) {
        results.push({ chunk, score });
      }
    }

    return results;
  }

  clearCache(): void {
    this.cachedVectors = null;
    this.cachedChunks = null;
    this.manifest = null;
  }
}

export class SemanticRetrieval {
  private indexes: Map<string, SemanticIndex> = new Map();
  private embedder: MultiProviderEmbedder;
  private basePath: string;

  constructor(config: ProviderConfig = {}, basePath: string = './data') {
    this.embedder = new MultiProviderEmbedder(config);
    this.basePath = basePath;
  }

  async initialize(): Promise<void> {
    await this.embedder.initialize();
  }

  getEmbedder(): MultiProviderEmbedder {
    return this.embedder;
  }

  getIndex(projectPath: string): SemanticIndex | undefined {
    return this.indexes.get(projectPath);
  }

  async getOrCreateIndex(projectPath: string): Promise<SemanticIndex> {
    let index = this.indexes.get(projectPath);
    if (!index) {
      index = new SemanticIndex(this.embedder, this.basePath);
      this.indexes.set(projectPath, index);
    }
    return index;
  }

  async loadIndex(projectPath: string): Promise<boolean> {
    const index = await this.getOrCreateIndex(projectPath);
    return index.load(projectPath);
  }

  async buildIndex(chunks: CodeChunk[], projectPath: string): Promise<void> {
    const index = await this.getOrCreateIndex(projectPath);
    await index.build(chunks, projectPath);
  }

  async search(projectPath: string, query: string, topK: number = 10): Promise<Array<{ chunk: CodeChunk; score: number }>> {
    const index = this.indexes.get(projectPath);
    if (!index) {
      throw new Error(`[SemanticRetrieval] No index loaded for ${projectPath}. Call loadIndex() first.`);
    }
    return index.search(query, topK);
  }
}
