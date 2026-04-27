import type { CodeChunk, DependencyEdge, SearchResult, ProjectStats, SearchOptions } from '../types.js';
import type { Node, Edge } from '../graph/types.js';
import { EMBEDDING_DIMENSIONS } from '../types.js';
import { Schema, Field, FixedSizeList, Float32, Utf8, Int32, Bool } from 'apache-arrow';
import lancedb from '@lancedb/lancedb';
import { BM25 } from '../search/bm25.js';

const CODE_CHUNKS_TABLE = 'code_chunks';
const DEPENDENCY_GRAPH_TABLE = 'dependency_graph';
const GRAPH_NODES_TABLE = 'graph_nodes';
const GRAPH_EDGES_TABLE = 'graph_edges';

export interface DBConfig {
  uri: string;
  codeChunksTable?: string;
  dependencyGraphTable?: string;
  graphNodesTable?: string;
  graphEdgesTable?: string;
}

interface CodeChunkRecord {
  id: string;
  projectPath: string;
  filePath: string;
  content: string;
  summary?: string;
  startLine: number;
  endLine: number;
  language: string;
  chunkType: string;
  fqn?: string;
  parentId?: string;
  metadata: string;
  vector: number[];
  summaryVectorJson?: string;
  fileHash?: string;
}

interface DependencyEdgeRecord {
  sourceId: string;
  targetId: string;
  sourceFile: string;
  targetFile: string;
  projectPath: string;
  importName?: string;
  line?: number;
}

export class Database {
  private uri: string;
  private codeChunksTable: string;
  private dependencyGraphTable: string;
  private graphNodesTable: string;
  private graphEdgesTable: string;
  private db: any = null;
  private chunksTable: any = null;
  private graphTable: any = null;
  private nodesTable: any = null;
  private edgesTable: any = null;

  constructor(config: DBConfig) {
    this.uri = config.uri;
    this.codeChunksTable = config.codeChunksTable ?? CODE_CHUNKS_TABLE;
    this.dependencyGraphTable = config.dependencyGraphTable ?? DEPENDENCY_GRAPH_TABLE;
    this.graphNodesTable = config.graphNodesTable ?? GRAPH_NODES_TABLE;
    this.graphEdgesTable = config.graphEdgesTable ?? GRAPH_EDGES_TABLE;
  }

  async initDatabase(): Promise<void> {
    const lancedb = await import('@lancedb/lancedb');
    const connect = lancedb.connect;
    this.db = await connect(this.uri);

    const tableNames = await this.db.tableNames();
    const existingTables = new Set(tableNames);

    const chunksSchema = new Schema([
      new Field('id', new Utf8()),
      new Field('projectPath', new Utf8()),
      new Field('filePath', new Utf8()),
      new Field('content', new Utf8()),
      new Field('summary', new Utf8(), true),
      new Field('startLine', new Int32()),
      new Field('endLine', new Int32()),
      new Field('language', new Utf8()),
      new Field('chunkType', new Utf8()),
      new Field('fqn', new Utf8(), true),
      new Field('parentId', new Utf8(), true),
      new Field('metadata', new Utf8()),
      new Field('vector', new FixedSizeList(EMBEDDING_DIMENSIONS, new Field('', new Float32()))),
      new Field('summaryVectorJson', new Utf8(), true),
      new Field('fileHash', new Utf8()),
    ]);

    const graphSchema = new Schema([
      new Field('sourceId', new Utf8()),
      new Field('targetId', new Utf8()),
      new Field('sourceFile', new Utf8()),
      new Field('targetFile', new Utf8()),
      new Field('projectPath', new Utf8()),
      new Field('importName', new Utf8(), true),
      new Field('line', new Int32(), true),
    ]);

    const nodesSchema = new Schema([
      new Field('id', new Utf8()),
      new Field('kind', new Utf8()),
      new Field('name', new Utf8()),
      new Field('qualifiedName', new Utf8()),
      new Field('filePath', new Utf8()),
      new Field('language', new Utf8()),
      new Field('startLine', new Int32()),
      new Field('endLine', new Int32()),
      new Field('startColumn', new Int32()),
      new Field('endColumn', new Int32()),
      new Field('isExported', new Bool()),
      new Field('projectPath', new Utf8()),
      new Field('metadata', new Utf8()),
    ]);

    const edgesSchema = new Schema([
      new Field('source', new Utf8()),
      new Field('target', new Utf8()),
      new Field('kind', new Utf8()),
      new Field('projectPath', new Utf8()),
      new Field('metadata', new Utf8()),
      new Field('line', new Int32(), true),
    ]);

    try {
      if (!existingTables.has(this.codeChunksTable)) {
        this.chunksTable = await this.db.createEmptyTable(this.codeChunksTable, chunksSchema);
      } else {
        this.chunksTable = await this.db.openTable(this.codeChunksTable);
      }
    } catch (err) {
      console.warn('[Database] code_chunks table corrupted, recreating:', err instanceof Error ? err.message : err);
      try { await this.db.dropTable(this.codeChunksTable); } catch {}
      this.chunksTable = await this.db.createEmptyTable(this.codeChunksTable, chunksSchema);
    }

    try {
      if (!existingTables.has(this.dependencyGraphTable)) {
        this.graphTable = await this.db.createEmptyTable(this.dependencyGraphTable, graphSchema);
      } else {
        this.graphTable = await this.db.openTable(this.dependencyGraphTable);
      }
    } catch (err) {
      console.warn('[Database] dependency_graph table corrupted, recreating');
      try { await this.db.dropTable(this.dependencyGraphTable); } catch {}
      this.graphTable = await this.db.createEmptyTable(this.dependencyGraphTable, graphSchema);
    }

    try {
      if (!existingTables.has(this.graphNodesTable)) {
        this.nodesTable = await this.db.createEmptyTable(this.graphNodesTable, nodesSchema);
      } else {
        this.nodesTable = await this.db.openTable(this.graphNodesTable);
      }
    } catch (err) {
      console.warn('[Database] graph_nodes table corrupted, recreating');
      try { await this.db.dropTable(this.graphNodesTable); } catch {}
      this.nodesTable = await this.db.createEmptyTable(this.graphNodesTable, nodesSchema);
    }

    try {
      if (!existingTables.has(this.graphEdgesTable)) {
        this.edgesTable = await this.db.createEmptyTable(this.graphEdgesTable, edgesSchema);
      } else {
        this.edgesTable = await this.db.openTable(this.graphEdgesTable);
      }
    } catch (err) {
      console.warn('[Database] graph_edges table corrupted, recreating');
      try { await this.db.dropTable(this.graphEdgesTable); } catch {}
      this.edgesTable = await this.db.createEmptyTable(this.graphEdgesTable, edgesSchema);
    }
  }

  async upsertChunk(chunk: CodeChunk, embedding: number[], projectPath: string): Promise<void> {
    await this.upsertChunks([chunk], [embedding], projectPath);
  }

  async upsertChunks(
    chunks: CodeChunk[],
    embeddings: number[][],
    projectPath: string,
    summaryEmbeddings?: number[][]
  ): Promise<void> {
    if (!this.chunksTable) throw new Error('Database not initialized');

    const chunksSchema = new Schema([
      new Field('id', new Utf8()),
      new Field('projectPath', new Utf8()),
      new Field('filePath', new Utf8()),
      new Field('content', new Utf8()),
      new Field('summary', new Utf8(), true),
      new Field('startLine', new Int32()),
      new Field('endLine', new Int32()),
      new Field('language', new Utf8()),
      new Field('chunkType', new Utf8()),
      new Field('fqn', new Utf8(), true),
      new Field('parentId', new Utf8(), true),
      new Field('metadata', new Utf8()),
      new Field('vector', new FixedSizeList(EMBEDDING_DIMENSIONS, new Field('', new Float32()))),
      new Field('summaryVectorJson', new Utf8(), true),
      new Field('fileHash', new Utf8()),
    ]);

    const records = chunks.map((chunk, i) => ({
      id: chunk.id,
      projectPath,
      filePath: chunk.filePath,
      content: chunk.content,
      summary: chunk.summary ?? null,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      language: chunk.language,
      chunkType: chunk.chunkType,
      fqn: chunk.fqn ?? null,
      parentId: chunk.parentId ?? null,
      metadata: JSON.stringify(chunk.metadata),
      vector: embeddings[i] ?? new Array(EMBEDDING_DIMENSIONS).fill(0),
      summaryVectorJson: summaryEmbeddings?.[i] ? JSON.stringify(summaryEmbeddings[i]) : null,
      fileHash: chunk.fileHash ?? null,
    }));

    try {
      await this.chunksTable.add(records);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      if (errorMsg.includes('schema') || errorMsg.includes('fields did not match')) {
        console.warn('[Database] Schema mismatch (fileHash field missing), recreating table...');
        try { await this.db.dropTable(this.codeChunksTable); } catch {}
        this.chunksTable = await this.db.createEmptyTable(this.codeChunksTable, chunksSchema);
        await this.chunksTable.add(records);
      } else {
        throw err;
      }
    }

    try {
      await this.chunksTable.createIndex('vector', {
        config: lancedb.Index.ivfPq({}),
      });
    } catch (err) {
      // Index might already exist, ignore
    }
  }

  async searchChunks(
    projectPath: string,
    embedding: number[],
    limit: number,
    filters?: SearchOptions['filters']
  ): Promise<SearchResult[]> {
    if (!this.chunksTable) throw new Error('Database not initialized');

    let query = this.chunksTable.query();
    if (projectPath) {
      query = query.where(`projectPath = "${projectPath}"`);
    }
    if (filters?.language) {
      query = query.where(`language = "${filters.language}"`);
    }
    if (filters?.filePath) {
      query = query.where(`filePath LIKE "${filters.filePath}%"`);
    }
    if (filters?.chunkTypes && filters.chunkTypes.length > 0) {
      const types = filters.chunkTypes.map(t => `"${t}"`).join(', ');
      query = query.where(`chunkType IN [${types}]`);
    }

    const results = await query.nearestTo(embedding, { column: 'vector' }).limit(limit).toArray();

    return results.map((row: any) => ({
      chunk: {
        id: row.id,
        filePath: row.filePath,
        content: row.content,
        summary: row.summary ?? undefined,
        startLine: row.startLine,
        endLine: row.endLine,
        language: row.language,
        chunkType: row.chunkType as CodeChunk['chunkType'],
        fqn: row.fqn,
        parentId: row.parentId,
        metadata: JSON.parse(row.metadata ?? '{}'),
      },
      score: row._distance ?? 0,
      query: '',
      highlights: [],
    }));
  }

  async getIndexedFileHashes(projectPath: string): Promise<Map<string, string>> {
    if (!this.chunksTable) throw new Error('Database not initialized');

    const hashes = new Map<string, string>();

    let query = this.chunksTable.query();
    if (projectPath) {
      query = query.where(`projectPath = "${projectPath}"`);
    }

    const results = await query.select(['filePath', 'fileHash']).toArray();

    for (const row of results) {
      if (row.fileHash && row.filePath) {
        hashes.set(row.filePath, row.fileHash);
      }
    }

    return hashes;
  }

  async searchChunksWithSummary(
    projectPath: string,
    contentEmbedding: number[],
    summaryEmbedding: number[],
    limit: number,
    filters?: SearchOptions['filters'],
    summaryWeight: number = 0.3
  ): Promise<SearchResult[]> {
    if (!this.chunksTable) throw new Error('Database not initialized');

    let query = this.chunksTable.query();
    if (projectPath) {
      query = query.where(`projectPath = "${projectPath}"`);
    }
    if (filters?.language) {
      query = query.where(`language = "${filters.language}"`);
    }
    if (filters?.filePath) {
      query = query.where(`filePath LIKE "${filters.filePath}%"`);
    }
    if (filters?.chunkTypes && filters.chunkTypes.length > 0) {
      const types = filters.chunkTypes.map(t => `"${t}"`).join(', ');
      query = query.where(`chunkType IN [${types}]`);
    }

    const contentResults = await query.clone().nearestTo(contentEmbedding, { column: 'vector' }).limit(limit * 3).toArray();

    if (contentResults.length === 0) return [];

    const contentWeight = 1 - summaryWeight;
    const finalResults: SearchResult[] = [];

    for (const row of contentResults) {
      const contentScore = row._distance !== undefined ? 1 - row._distance : 0;

      let summaryScore = 0;
      if (row.summaryVectorJson) {
        try {
          const summaryVec = JSON.parse(row.summaryVectorJson);
          if (Array.isArray(summaryVec) && summaryVec.length === contentEmbedding.length) {
            summaryScore = this.cosineSimilarity(summaryEmbedding, summaryVec);
          }
        } catch {
          summaryScore = 0;
        }
      }

      const combinedScore = (contentScore * contentWeight) + (summaryScore * summaryWeight);

      finalResults.push({
        chunk: {
          id: row.id,
          filePath: row.filePath,
          content: row.content,
          summary: row.summary ?? undefined,
          startLine: row.startLine,
          endLine: row.endLine,
          language: row.language,
          chunkType: row.chunkType as CodeChunk['chunkType'],
          fqn: row.fqn,
          parentId: row.parentId,
          metadata: JSON.parse(row.metadata ?? '{}'),
        },
        score: combinedScore,
        query: '',
        highlights: [],
      });
    }

    finalResults.sort((a, b) => b.score - a.score);
    return finalResults.slice(0, limit);
  }

  async deleteProjectChunks(projectPath: string): Promise<void> {
    if (!this.chunksTable) throw new Error('Database not initialized');
    if (!this.graphTable) throw new Error('Database not initialized');
    await this.chunksTable.delete(`projectPath = "${projectPath}"`);
    await this.graphTable.delete(`projectPath = "${projectPath}"`);
  }

  async getProjectStats(projectPath: string): Promise<ProjectStats> {
    if (!this.chunksTable) throw new Error('Database not initialized');
    const results = await this.chunksTable.query()
      .where(`projectPath = "${projectPath}"`)
      .select(['filePath', 'content', 'language', 'startLine', 'endLine'])
      .toArray();

    const files = new Set<string>();
    let totalLines = 0;
    const languages: Record<string, number> = {};

    for (const row of results) {
      files.add(row.filePath);
      totalLines += row.endLine - row.startLine + 1;
      languages[row.language] = (languages[row.language] ?? 0) + 1;
    }

    return {
      projectPath,
      totalChunks: results.length,
      totalFiles: files.size,
      totalLines,
      lastIndexed: new Date(),
      languages,
      indexSizeBytes: 0,
    };
  }

  async upsertDependencyEdges(edges: DependencyEdge[], projectPath: string): Promise<void> {
    if (!this.graphTable) throw new Error('Database not initialized');
    const records = edges.map(edge => ({
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      sourceFile: edge.sourceFile,
      targetFile: edge.targetFile,
      projectPath,
      importName: edge.importName ?? null,
      line: edge.line ?? null,
    }));
    await this.graphTable.add(records);
  }

  async upsertNodes(nodes: Node[], projectPath: string): Promise<void> {
    if (!this.nodesTable) throw new Error('Database not initialized');
    const records = nodes.map(node => ({
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName,
      filePath: node.filePath,
      language: node.language,
      startLine: node.startLine,
      endLine: node.endLine,
      startColumn: node.startColumn,
      endColumn: node.endColumn,
      isExported: node.isExported ?? false,
      projectPath,
      metadata: JSON.stringify({}),
    }));
    await this.nodesTable.add(records);
  }

  async upsertEdges(edges: Edge[], projectPath: string): Promise<void> {
    if (!this.edgesTable) throw new Error('Database not initialized');
    if (edges.length === 0) return;
    const records = edges.map(edge => ({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      projectPath,
      metadata: JSON.stringify(edge.metadata ?? {}),
      line: edge.line ?? null,
    }));
    await this.edgesTable.add(records);
  }

  async getNode(nodeId: string): Promise<Node | null> {
    if (!this.nodesTable) throw new Error('Database not initialized');
    const results = await this.nodesTable.query()
      .where(`id = "${nodeId}"`)
      .limit(1)
      .toArray();
    if (results.length === 0) return null;
    const row = results[0];
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      qualifiedName: row.qualifiedName,
      filePath: row.filePath,
      language: row.language,
      startLine: row.startLine,
      endLine: row.endLine,
      startColumn: row.startColumn,
      endColumn: row.endColumn,
      isExported: row.isExported,
      updatedAt: Date.now(),
    };
  }

  async getNodesByFile(filePath: string): Promise<Node[]> {
    if (!this.nodesTable) throw new Error('Database not initialized');
    const results = await this.nodesTable.query()
      .where(`filePath = "${filePath}"`)
      .toArray();
    return results.map((row: any) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      qualifiedName: row.qualifiedName,
      filePath: row.filePath,
      language: row.language,
      startLine: row.startLine,
      endLine: row.endLine,
      startColumn: row.startColumn,
      endColumn: row.endColumn,
      isExported: row.isExported,
      updatedAt: Date.now(),
    }));
  }

  async getEdgesByNode(nodeId: string): Promise<Edge[]> {
    if (!this.edgesTable) throw new Error('Database not initialized');
    const results = await this.edgesTable.query()
      .where(`source = "${nodeId}" OR target = "${nodeId}"`)
      .toArray();
    return results.map((row: any) => ({
      source: row.source,
      target: row.target,
      kind: row.kind,
      metadata: JSON.parse(row.metadata ?? '{}'),
      line: row.line,
    }));
  }

  async deleteFileGraph(filePath: string): Promise<void> {
    if (!this.nodesTable || !this.edgesTable) throw new Error('Database not initialized');
    await this.nodesTable.delete(`filePath = "${filePath}"`);
    const nodeIds = await this.nodesTable.query()
      .where(`filePath = "${filePath}"`)
      .select(['id'])
      .toArray();
    for (const row of nodeIds) {
      await this.edgesTable.delete(`source = "${row.id}" OR target = "${row.id}"`);
    }
  }

  async getAllNodes(): Promise<Node[]> {
    if (!this.nodesTable) throw new Error('Database not initialized');
    const results = await this.nodesTable.query().toArray();
    return results.map((row: any) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      qualifiedName: row.qualifiedName,
      filePath: row.filePath,
      language: row.language,
      startLine: row.startLine,
      endLine: row.endLine,
      startColumn: row.startColumn,
      endColumn: row.endColumn,
      isExported: row.isExported,
      updatedAt: Date.now(),
    }));
  }

  async getAllEdges(): Promise<Edge[]> {
    if (!this.edgesTable) throw new Error('Database not initialized');
    const results = await this.edgesTable.query().toArray();
    return results.map((row: any) => ({
      source: row.source,
      target: row.target,
      kind: row.kind,
      metadata: JSON.parse(row.metadata ?? '{}'),
      line: row.line,
    }));
  }

  async initialize(): Promise<void> {
    await this.initDatabase();
  }

  async search(queryEmbedding: number[], options?: Partial<SearchOptions>): Promise<SearchResult[]> {
    const projectPath = options?.projectPath ?? '';
    return this.searchChunks(projectPath, queryEmbedding, options?.limit ?? 10, options?.filters);
  }

  async searchWithGraphBoost(
    queryEmbedding: number[],
    options?: Partial<SearchOptions & { graphBoost?: number; maxResults?: number }>
  ): Promise<SearchResult[]> {
    if (!this.chunksTable || !this.nodesTable || !this.edgesTable) {
      throw new Error('Database not initialized');
    }

    const projectPath = options?.projectPath ?? '';
    const limit = options?.limit ?? 10;
    const graphBoost = options?.graphBoost ?? 0.3;
    const maxResults = options?.maxResults ?? limit * 3;

    const vectorResults = await this.searchChunks(projectPath, queryEmbedding, maxResults, options?.filters);

    if (vectorResults.length === 0) return [];

    const fqnToChunk = new Map<string, SearchResult>();
    for (const result of vectorResults) {
      if (result.chunk.fqn) {
        fqnToChunk.set(result.chunk.fqn, result);
      }
    }

    const nodeMap = new Map<string, { id: string; qualifiedName: string }>();
    const nodes: Array<{ id: string; qualifiedName: string }> = await this.nodesTable.query()
      .where(projectPath ? `filePath LIKE "${projectPath}%"` : '1=1')
      .select(['id', 'qualifiedName'])
      .toArray();
    for (const node of nodes) {
      nodeMap.set(node.qualifiedName, { id: node.id, qualifiedName: node.qualifiedName });
    }

    const relatedFqns = new Set<string>();
    for (const [fqn, node] of nodeMap) {
      const edges: Array<{ source: string; target: string }> = await this.edgesTable.query()
        .where(`source = "${node.id}" OR target = "${node.id}"`)
        .select(['source', 'target'])
        .toArray();

      for (const edge of edges) {
        const relatedId = edge.source === node.id ? edge.target : edge.source;
        const relatedNode = nodes.find((n: { id: string }) => n.id === relatedId);
        if (relatedNode) {
          relatedFqns.add(relatedNode.qualifiedName);
        }
      }
    }

    const boostedResults = vectorResults.map(result => {
      let boost = 0;
      if (result.chunk.fqn && relatedFqns.has(result.chunk.fqn)) {
        boost = graphBoost;
      }
      return {
        ...result,
        score: result.score + boost,
      };
    });

    boostedResults.sort((a, b) => b.score - a.score);
    return boostedResults.slice(0, limit);
  }

  async searchHybrid(
    queryText: string,
    queryEmbedding: number[],
    options?: Partial<SearchOptions & { graphBoost?: number; maxResults?: number; bm25Weight?: number; vectorWeight?: number; graphWeight?: number }>
  ): Promise<SearchResult[]> {
    if (!this.chunksTable || !this.nodesTable || !this.edgesTable) {
      throw new Error('Database not initialized');
    }

    const projectPath = options?.projectPath ?? '';
    const limit = options?.limit ?? 10;
    const graphBoost = options?.graphBoost ?? 0.3;
    const maxResults = options?.maxResults ?? limit * 5;
    const bm25Weight = options?.bm25Weight ?? 0.3;
    const vectorWeight = options?.vectorWeight ?? 0.5;
    const graphWeight = options?.graphWeight ?? 0.2;

    let query = this.chunksTable.query();
    if (projectPath) {
      query = query.where(`projectPath = "${projectPath}"`);
    }
    if (options?.filters?.language) {
      query = query.where(`language = "${options.filters.language}"`);
    }
    if (options?.filters?.filePath) {
      query = query.where(`filePath LIKE "${options.filters.filePath}%"`);
    }

    const allChunks = await query.select(['id', 'filePath', 'content', 'startLine', 'endLine', 'language', 'chunkType', 'fqn', 'metadata']).toArray();

    if (allChunks.length === 0) return [];

    const bm25 = new BM25();
    const contents = allChunks.map((row: any) => row.content as string);
    bm25.index(contents);

    const bm25Results = bm25.search(queryText, maxResults);
    const bm25ScoreMap = new Map<number, number>();
    const firstBm25Result = bm25Results[0];
    const maxBm25 = firstBm25Result ? firstBm25Result.score : 1;
    for (const r of bm25Results) {
      bm25ScoreMap.set(r.index, r.score / maxBm25);
    }

    const nodeMap = new Map<string, { id: string; qualifiedName: string }>();
    const nodes: Array<{ id: string; qualifiedName: string }> = await this.nodesTable.query()
      .where(projectPath ? `filePath LIKE "${projectPath}%"` : '1=1')
      .select(['id', 'qualifiedName'])
      .toArray();
    for (const node of nodes) {
      nodeMap.set(node.qualifiedName, { id: node.id, qualifiedName: node.qualifiedName });
    }

    const relatedFqns = new Set<string>();
    for (const [, node] of nodeMap) {
      const edges: Array<{ source: string; target: string }> = await this.edgesTable.query()
        .where(`source = "${node.id}" OR target = "${node.id}"`)
        .select(['source', 'target'])
        .toArray();

      for (const edge of edges) {
        const relatedId = edge.source === node.id ? edge.target : edge.source;
        const relatedNode = nodes.find((n: { id: string }) => n.id === relatedId);
        if (relatedNode) {
          relatedFqns.add(relatedNode.qualifiedName);
        }
      }
    }

    const chunkIdToIndex = new Map<string, number>();
    allChunks.forEach((_: any, idx: number) => chunkIdToIndex.set((_ as any).id, idx));

    const nodeResults = await this.searchChunks(projectPath, queryEmbedding, maxResults, options?.filters);
    const vectorScoreMap = new Map<number, number>();
    const firstNodeResult = nodeResults[0];
    const maxVector = firstNodeResult ? firstNodeResult.score : 1;
    for (const r of nodeResults) {
      const idx = chunkIdToIndex.get(r.chunk.id);
      if (idx !== undefined) {
        vectorScoreMap.set(idx, r.score / maxVector);
      }
    }

    const finalScores: Array<{ index: number; combinedScore: number; chunk: SearchResult['chunk'] }> = [];

    for (let i = 0; i < allChunks.length; i++) {
      const row = allChunks[i] as any;
      const bm25Score = bm25ScoreMap.get(i) ?? 0;
      const vectorScore = vectorScoreMap.get(i) ?? 0;

      let graphBoostScore = 0;
      if (row.fqn && relatedFqns.has(row.fqn)) {
        graphBoostScore = graphBoost;
      }

      const combinedScore = (bm25Score * bm25Weight) + (vectorScore * vectorWeight) + (graphBoostScore * graphWeight);

      if (combinedScore > 0) {
        finalScores.push({
          index: i,
          combinedScore,
          chunk: {
            id: row.id,
            filePath: row.filePath,
            content: row.content,
            startLine: row.startLine,
            endLine: row.endLine,
            language: row.language,
            chunkType: row.chunkType as CodeChunk['chunkType'],
            fqn: row.fqn,
            metadata: JSON.parse(row.metadata ?? '{}'),
          },
        });
      }
    }

    finalScores.sort((a, b) => b.combinedScore - a.combinedScore);

    return finalScores.slice(0, limit).map(r => ({
      chunk: r.chunk,
      score: r.combinedScore,
      query: queryText,
      highlights: [],
    }));
  }

  async searchHybridWithSummary(
    queryText: string,
    contentEmbedding: number[],
    summaryEmbedding: number[],
    options?: Partial<SearchOptions & { graphBoost?: number; maxResults?: number; bm25Weight?: number; vectorWeight?: number; graphWeight?: number; summaryWeight?: number }>
  ): Promise<SearchResult[]> {
    if (!this.chunksTable || !this.nodesTable || !this.edgesTable) {
      throw new Error('Database not initialized');
    }

    const projectPath = options?.projectPath ?? '';
    const limit = options?.limit ?? 10;
    const graphBoost = options?.graphBoost ?? 0.3;
    const maxResults = options?.maxResults ?? limit * 5;
    const bm25Weight = options?.bm25Weight ?? 0.25;
    const vectorWeight = options?.vectorWeight ?? 0.35;
    const graphWeight = options?.graphWeight ?? 0.15;
    const summaryWeight = options?.summaryWeight ?? 0.25;

    let query = this.chunksTable.query();
    if (projectPath) {
      query = query.where(`projectPath = "${projectPath}"`);
    }
    if (options?.filters?.language) {
      query = query.where(`language = "${options.filters.language}"`);
    }
    if (options?.filters?.filePath) {
      query = query.where(`filePath LIKE "${options.filters.filePath}%"`);
    }

    const allChunks = await query.select([
      'id', 'filePath', 'content', 'summary', 'startLine', 'endLine',
      'language', 'chunkType', 'fqn', 'metadata', 'vector', 'summaryVectorJson'
    ]).toArray();

    if (allChunks.length === 0) return [];

    const bm25 = new BM25();
    const contents = allChunks.map((row: any) => row.content as string);
    bm25.index(contents);

    const bm25Results = bm25.search(queryText, maxResults);
    const bm25ScoreMap = new Map<number, number>();
    const firstBm25Result = bm25Results[0];
    const maxBm25 = firstBm25Result ? firstBm25Result.score : 1;
    for (const r of bm25Results) {
      bm25ScoreMap.set(r.index, r.score / maxBm25);
    }

    const nodeMap = new Map<string, { id: string; qualifiedName: string }>();
    const nodes: Array<{ id: string; qualifiedName: string }> = await this.nodesTable.query()
      .where(projectPath ? `filePath LIKE "${projectPath}%"` : '1=1')
      .select(['id', 'qualifiedName'])
      .toArray();
    for (const node of nodes) {
      nodeMap.set(node.qualifiedName, { id: node.id, qualifiedName: node.qualifiedName });
    }

    const relatedFqns = new Set<string>();
    for (const [, node] of nodeMap) {
      const edges: Array<{ source: string; target: string }> = await this.edgesTable.query()
        .where(`source = "${node.id}" OR target = "${node.id}"`)
        .select(['source', 'target'])
        .toArray();

      for (const edge of edges) {
        const relatedId = edge.source === node.id ? edge.target : edge.source;
        const relatedNode = nodes.find((n: { id: string }) => n.id === relatedId);
        if (relatedNode) {
          relatedFqns.add(relatedNode.qualifiedName);
        }
      }
    }

    const chunkIdToIndex = new Map<string, number>();
    allChunks.forEach((_: any, idx: number) => chunkIdToIndex.set((_ as any).id, idx));

    const nodeResults = await this.searchChunks(projectPath, contentEmbedding, maxResults, options?.filters);
    const vectorScoreMap = new Map<number, number>();
    const firstNodeResult = nodeResults[0];
    const maxVector = firstNodeResult ? firstNodeResult.score : 1;
    for (const r of nodeResults) {
      const idx = chunkIdToIndex.get(r.chunk.id);
      if (idx !== undefined) {
        vectorScoreMap.set(idx, r.score / maxVector);
      }
    }

    const finalScores: Array<{ index: number; combinedScore: number; chunk: SearchResult['chunk'] }> = [];

    for (let i = 0; i < allChunks.length; i++) {
      const row = allChunks[i] as any;
      const bm25Score = bm25ScoreMap.get(i) ?? 0;
      const vectorScore = vectorScoreMap.get(i) ?? 0;

      let graphBoostScore = 0;
      if (row.fqn && relatedFqns.has(row.fqn)) {
        graphBoostScore = graphBoost;
      }

      let summaryScore = 0;
      if (row.summaryVectorJson) {
        try {
          const summaryVec = JSON.parse(row.summaryVectorJson);
          if (Array.isArray(summaryVec) && summaryVec.length === summaryEmbedding.length) {
            summaryScore = this.cosineSimilarity(summaryEmbedding, summaryVec);
          }
        } catch {
          summaryScore = 0;
        }
      }

      const combinedScore = (bm25Score * bm25Weight) + (vectorScore * vectorWeight) + (graphBoostScore * graphWeight) + (summaryScore * summaryWeight);

      if (combinedScore > 0) {
        finalScores.push({
          index: i,
          combinedScore,
          chunk: {
            id: row.id,
            filePath: row.filePath,
            content: row.content,
            summary: row.summary ?? undefined,
            startLine: row.startLine,
            endLine: row.endLine,
            language: row.language,
            chunkType: row.chunkType as CodeChunk['chunkType'],
            fqn: row.fqn,
            metadata: JSON.parse(row.metadata ?? '{}'),
          },
        });
      }
    }

    finalScores.sort((a, b) => b.combinedScore - a.combinedScore);

    return finalScores.slice(0, limit).map(r => ({
      chunk: r.chunk,
      score: r.combinedScore,
      query: queryText,
      highlights: [],
    }));
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += (a[i] ?? 0) * (b[i] ?? 0);
      normA += (a[i] ?? 0) * (a[i] ?? 0);
      normB += (b[i] ?? 0) * (b[i] ?? 0);
    }
    const norm = Math.sqrt(normA) * Math.sqrt(normB);
    return norm > 0 ? dot / norm : 0;
  }

  async removeByPath(path: string): Promise<void> {
    if (!this.chunksTable) throw new Error('Database not initialized');
    await this.chunksTable.delete(`filePath = "${path}"`);
  }

  async getStats(projectPath?: string): Promise<ProjectStats> {
    if (!this.chunksTable) throw new Error('Database not initialized');
    if (!projectPath) {
      return {
        projectPath: '',
        totalChunks: 0,
        totalFiles: 0,
        totalLines: 0,
        lastIndexed: new Date(),
        languages: {},
        indexSizeBytes: 0,
      };
    }
    return this.getProjectStats(projectPath);
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db = null;
      this.chunksTable = null;
      this.graphTable = null;
      this.nodesTable = null;
      this.edgesTable = null;
    }
  }
}
