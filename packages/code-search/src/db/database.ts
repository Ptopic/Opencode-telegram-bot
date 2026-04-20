import type { CodeChunk, DependencyEdge, SearchResult, ProjectStats, SearchOptions } from '../types.js';
import type { Node, Edge } from '../graph/types.js';
import { EMBEDDING_DIMENSIONS } from '../types.js';

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
  startLine: number;
  endLine: number;
  language: string;
  chunkType: string;
  fqn?: string;
  parentId?: string;
  metadata: string;
  vector: number[];
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

    try {
      this.chunksTable = await this.db.createEmptyTable(this.codeChunksTable, {
        schema: {
          fields: [
            { name: 'id', type: 'utf8' },
            { name: 'projectPath', type: 'utf8' },
            { name: 'filePath', type: 'utf8' },
            { name: 'content', type: 'utf8' },
            { name: 'startLine', type: 'int32' },
            { name: 'endLine', type: 'int32' },
            { name: 'language', type: 'utf8' },
            { name: 'chunkType', type: 'utf8' },
            { name: 'fqn', type: 'utf8', nullable: true },
            { name: 'parentId', type: 'utf8', nullable: true },
            { name: 'metadata', type: 'utf8' },
            { name: 'vector', type: `fixed_size_list[float32, ${EMBEDDING_DIMENSIONS}]` },
          ],
        },
      });
    } catch {
      this.chunksTable = await this.db.openTable(this.codeChunksTable);
    }

    try {
      this.graphTable = await this.db.createEmptyTable(this.dependencyGraphTable, {
        schema: {
          fields: [
            { name: 'sourceId', type: 'utf8' },
            { name: 'targetId', type: 'utf8' },
            { name: 'sourceFile', type: 'utf8' },
            { name: 'targetFile', type: 'utf8' },
            { name: 'projectPath', type: 'utf8' },
            { name: 'importName', type: 'utf8', nullable: true },
            { name: 'line', type: 'int32', nullable: true },
          ],
        },
      });
    } catch {
      this.graphTable = await this.db.openTable(this.dependencyGraphTable);
    }

    try {
      this.nodesTable = await this.db.createEmptyTable(this.graphNodesTable, {
        schema: {
          fields: [
            { name: 'id', type: 'utf8' },
            { name: 'kind', type: 'utf8' },
            { name: 'name', type: 'utf8' },
            { name: 'qualifiedName', type: 'utf8' },
            { name: 'filePath', type: 'utf8' },
            { name: 'language', type: 'utf8' },
            { name: 'startLine', type: 'int32' },
            { name: 'endLine', type: 'int32' },
            { name: 'startColumn', type: 'int32' },
            { name: 'endColumn', type: 'int32' },
            { name: 'isExported', type: 'bool' },
            { name: 'projectPath', type: 'utf8' },
            { name: 'metadata', type: 'utf8' },
          ],
        },
      });
    } catch {
      this.nodesTable = await this.db.openTable(this.graphNodesTable);
    }

    try {
      this.edgesTable = await this.db.createEmptyTable(this.graphEdgesTable, {
        schema: {
          fields: [
            { name: 'source', type: 'utf8' },
            { name: 'target', type: 'utf8' },
            { name: 'kind', type: 'utf8' },
            { name: 'projectPath', type: 'utf8' },
            { name: 'metadata', type: 'utf8' },
            { name: 'line', type: 'int32', nullable: true },
          ],
        },
      });
    } catch {
      this.edgesTable = await this.db.openTable(this.graphEdgesTable);
    }
  }

  async upsertChunk(chunk: CodeChunk, embedding: number[], projectPath: string): Promise<void> {
    await this.upsertChunks([chunk], [embedding], projectPath);
  }

  async upsertChunks(chunks: CodeChunk[], embeddings: number[][], projectPath: string): Promise<void> {
    if (!this.chunksTable) throw new Error('Database not initialized');
    const records = chunks.map((chunk, i) => ({
      id: chunk.id,
      projectPath,
      filePath: chunk.filePath,
      content: chunk.content,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      language: chunk.language,
      chunkType: chunk.chunkType,
      fqn: chunk.fqn ?? null,
      parentId: chunk.parentId ?? null,
      metadata: JSON.stringify(chunk.metadata),
      vector: embeddings[i] ?? new Array(EMBEDDING_DIMENSIONS).fill(0),
    }));
    await this.chunksTable.add(records);
    await this.chunksTable.createIndex({ column: 'vector', indexType: 'IVF_PQ' });
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

    const results = await query.limit(limit).toArray();
    return results.map((row: any) => ({
      chunk: {
        id: row.id,
        filePath: row.filePath,
        content: row.content,
        startLine: row.startLine,
        endLine: row.endLine,
        language: row.language,
        chunkType: row.chunkType as CodeChunk['chunkType'],
        fqn: row.fqn,
        parentId: row.parentId,
        metadata: JSON.parse(row.metadata ?? '{}'),
      },
      score: 0,
      query: '',
      highlights: [],
    }));
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
      .select(['filePath', 'content', 'language'])
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
    }));
    await this.nodesTable.add(records);
  }

  async upsertEdges(edges: Edge[], projectPath: string): Promise<void> {
    if (!this.edgesTable) throw new Error('Database not initialized');
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
    return this.searchChunks('', queryEmbedding, options?.limit ?? 10, options?.filters);
  }

  async removeByPath(path: string): Promise<void> {
    if (!this.chunksTable) throw new Error('Database not initialized');
    await this.chunksTable.delete(`filePath = "${path}"`);
  }

  async getStats(_projectPath?: string): Promise<ProjectStats> {
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
