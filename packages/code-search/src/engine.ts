import { Database } from './db/database.js';
import { ChunkManager } from './chunker/chunk-manager.js';
import { Embedder } from './embedder/embedder.js';
import { FileWatcher } from './watcher/file-watcher.js';
import type { SearchOptions, IndexOptions, ProjectStats, SearchResult } from './types.js';
import type { Node, Context } from './graph/types.js';
import { DefaultConfig, type Config } from './config/index.js';

export class CodeSearchEngine {
  private db: Database;
  private chunker: ChunkManager;
  private embedder: Embedder;
  private watcher: FileWatcher | null = null;
  private config: Config;
  private currentProjectPath: string = '';

  constructor(config: Partial<Config> = {}) {
    this.config = { ...DefaultConfig, ...config };
    this.db = new Database({
      uri: this.config.database.uri,
      codeChunksTable: this.config.database.codeChunksTable,
      dependencyGraphTable: this.config.database.dependencyGraphTable,
    });
    this.chunker = new ChunkManager({
      maxChunkSize: this.config.chunking.maxChunkSize ?? 1000,
      overlap: this.config.chunking.overlap ?? 100,
      strategy: this.config.chunking.strategy ?? 'line',
    }, this.db);
    this.embedder = new Embedder({
      provider: this.config.embedder.provider,
      model: this.config.embedder.model,
      apiKey: this.config.embedder.apiKey,
      baseUrl: this.config.embedder.baseUrl,
    });
  }

  async initialize(): Promise<void> {
    await this.db.initialize();
  }

  async indexPaths(paths: string[], options?: Partial<IndexOptions>): Promise<ProjectStats> {
    this.currentProjectPath = paths[0] ?? '';
    const chunks = await this.chunker.chunkDirectory(paths, { ...options, projectPath: this.currentProjectPath });
    const embeddings = await this.embedder.embedChunks(chunks);
    await this.db.upsertChunks(chunks, embeddings, this.currentProjectPath);
    return this.getStats();
  }

  async search(query: string, options?: Partial<SearchOptions>): Promise<SearchResult[]> {
    const queryEmbedding = await this.embedder.embedQuery(query);
    const results = await this.db.search(queryEmbedding, options);
    return results;
  }

  async removePath(path: string): Promise<void> {
    await this.db.removeByPath(path);
  }

  async getStats(): Promise<ProjectStats> {
    return this.db.getStats(this.currentProjectPath);
  }

  startWatching(paths: string[]): void {
    if (this.watcher) {
      this.watcher.stop();
    }
    this.watcher = new FileWatcher({
      paths,
      extensions: this.config.watcher.extensions,
      debounceMs: this.config.watcher.debounceMs,
      ignorePatterns: this.config.watcher.ignorePatterns,
    });
    this.watcher.on('change', async (filePath: string) => {
      const chunks = await this.chunker.chunkFile(filePath);
      const embeddings = await this.embedder.embedChunks(chunks);
      await this.db.upsertChunks(chunks, embeddings, this.currentProjectPath);
    });
    this.watcher.on('unlink', (filePath: string) => {
      this.removePath(filePath);
    });
    this.watcher.start();
  }

  stopWatching(): void {
    this.watcher?.stop();
    this.watcher = null;
  }

  async close(): Promise<void> {
    this.stopWatching();
    await this.db.close();
  }

  async getGraphNode(nodeId: string): Promise<Node | null> {
    return this.db.getNode(nodeId);
  }

  async getGraphNodeByFile(filePath: string): Promise<Node[]> {
    return this.db.getNodesByFile(filePath);
  }

  async getGraphCallers(qualifiedName: string): Promise<Node[]> {
    const allNodes = await this.db.getAllNodes();
    const edges = await this.db.getAllEdges();
    const callerIds = new Set<string>();

    for (const edge of edges) {
      if (edge.kind === 'calls') {
        const targetNode = allNodes.find(n => n.id === edge.target);
        if (targetNode?.qualifiedName === qualifiedName) {
          callerIds.add(edge.source);
        }
      }
    }

    return Array.from(callerIds).map(id => allNodes.find(n => n.id === id)).filter((n): n is Node => n !== undefined);
  }

  async getGraphCallees(qualifiedName: string): Promise<Node[]> {
    const allNodes = await this.db.getAllNodes();
    const edges = await this.db.getAllEdges();
    const calleeIds = new Set<string>();

    for (const edge of edges) {
      if (edge.kind === 'calls') {
        const sourceNode = allNodes.find(n => n.id === edge.source);
        if (sourceNode?.qualifiedName === qualifiedName) {
          calleeIds.add(edge.target);
        }
      }
    }

    return Array.from(calleeIds).map(id => allNodes.find(n => n.id === id)).filter((n): n is Node => n !== undefined);
  }

  async getGraphContext(nodeId: string): Promise<Context | null> {
    const focal = await this.db.getNode(nodeId);
    if (!focal) return null;

    const ancestors = await this.getAncestors(nodeId);
    const children = await this.getChildren(nodeId);

    const incomingEdges = await this.db.getEdgesByNode(nodeId);
    const incomingRefs: Array<{ node: Node; edge: any }> = [];
    for (const edge of incomingEdges) {
      if (edge.kind === 'contains') continue;
      const node = await this.db.getNode(edge.source);
      if (node) incomingRefs.push({ node, edge });
    }

    const outgoingRefs: Array<{ node: Node; edge: any }> = [];
    const outgoingEdges = await this.db.getEdgesByNode(nodeId);
    for (const edge of outgoingEdges) {
      if (edge.kind === 'contains') continue;
      const node = await this.db.getNode(edge.target);
      if (node) outgoingRefs.push({ node, edge });
    }

    const types: Node[] = [];
    const imports: Node[] = [];

    return { focal, ancestors, children, incomingRefs, outgoingRefs, types, imports };
  }

  async findDeadCode(): Promise<Node[]> {
    const allNodes = await this.db.getAllNodes();
    const edges = await this.db.getAllEdges();

    const calledBy = new Map<string, Set<string>>();

    for (const edge of edges) {
      if (edge.kind === 'calls') {
        if (!calledBy.has(edge.target)) calledBy.set(edge.target, new Set());
        calledBy.get(edge.target)!.add(edge.source);
      }
    }

    const deadCode: Node[] = [];

    for (const node of allNodes) {
      if (node.kind === 'import' || node.kind === 'variable' || node.kind === 'constant') continue;
      if (node.kind === 'class' || node.kind === 'function' || node.kind === 'method') continue;

      const hasCallers = calledBy.has(node.id) && calledBy.get(node.id)!.size > 0;
      if (!hasCallers) {
        deadCode.push(node);
      }
    }

    return deadCode;
  }

  private async getAncestors(nodeId: string): Promise<Node[]> {
    const ancestors: Node[] = [];
    const visited = new Set<string>();
    let currentId = nodeId;

    while (true) {
      if (visited.has(currentId)) break;
      visited.add(currentId);

      const containingEdges = await this.db.getEdgesByNode(currentId);
      const containsEdge = containingEdges.find(e => e.kind === 'contains' && e.target === currentId);

      if (!containsEdge) break;

      const parentNode = await this.db.getNode(containsEdge.source);
      if (parentNode) {
        ancestors.push(parentNode);
        currentId = parentNode.id;
      } else {
        break;
      }
    }

    return ancestors;
  }

  private async getChildren(nodeId: string): Promise<Node[]> {
    const edges = await this.db.getEdgesByNode(nodeId);
    const children: Node[] = [];

    for (const edge of edges) {
      if (edge.kind === 'contains' && edge.source === nodeId) {
        const childNode = await this.db.getNode(edge.target);
        if (childNode) children.push(childNode);
      }
    }

    return children;
  }
}
