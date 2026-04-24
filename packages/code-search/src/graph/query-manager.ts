import type { Node, Edge, Context } from './types.js';
import type { Database } from '../db/database.js';

export interface GraphQueryManagerConfig {
  maxDepth?: number;
}

export class GraphQueryManager {
  private db: Database;
  private maxDepth: number;

  constructor(db: Database, config: GraphQueryManagerConfig = {}) {
    this.db = db;
    this.maxDepth = config.maxDepth ?? 10;
  }

  async getNode(nodeId: string): Promise<Node | null> {
    return this.db.getNode(nodeId);
  }

  async getNodesByFile(filePath: string): Promise<Node[]> {
    return this.db.getNodesByFile(filePath);
  }

  async getEdgesByNode(nodeId: string): Promise<Edge[]> {
    return this.db.getEdgesByNode(nodeId);
  }

  async getContext(nodeId: string): Promise<Context | null> {
    const focal = await this.getNode(nodeId);
    if (!focal) return null;

    const ancestors = await this.getAncestors(nodeId);
    const children = await this.getChildren(nodeId);

    const incomingEdges = await this.getEdgesByNode(nodeId);
    const incomingRefs: Array<{ node: Node; edge: Edge }> = [];
    for (const edge of incomingEdges) {
      if (edge.kind === 'contains') continue;
      const node = await this.getNode(edge.source);
      if (node) incomingRefs.push({ node, edge });
    }

    const outgoingRefs: Array<{ node: Node; edge: Edge }> = [];
    for (const edge of incomingEdges) {
      if (edge.kind === 'contains') continue;
      const node = await this.getNode(edge.target);
      if (node) outgoingRefs.push({ node, edge });
    }

    const types: Node[] = [];
    const imports: Node[] = [];

    return { focal, ancestors, children, incomingRefs, outgoingRefs, types, imports };
  }

  async getCallers(qualifiedName: string): Promise<Node[]> {
    const allNodes = await this.getAllNodes();
    const nodeMap = new Map<string, Node>();
    allNodes.forEach(n => nodeMap.set(n.qualifiedName, n));

    const edges = await this.getAllEdges();
    const callerIds = new Set<string>();

    for (const edge of edges) {
      if (edge.kind === 'calls') {
        const targetNode = allNodes.find(n => n.id === edge.target);
        if (targetNode?.qualifiedName === qualifiedName) {
          const sourceNode = allNodes.find(n => n.id === edge.source);
          if (sourceNode) {
            callerIds.add(sourceNode.id);
          }
        }
      }
    }

    return Array.from(callerIds).map(id => nodeMap.get(id)).filter((n): n is Node => n !== undefined);
  }

  async getCallees(qualifiedName: string): Promise<Node[]> {
    const allNodes = await this.getAllNodes();
    const nodeMap = new Map<string, Node>();
    allNodes.forEach(n => nodeMap.set(n.qualifiedName, n));

    const edges = await this.getAllEdges();
    const calleeIds = new Set<string>();

    for (const edge of edges) {
      if (edge.kind === 'calls') {
        const sourceNode = allNodes.find(n => n.id === edge.source);
        if (sourceNode?.qualifiedName === qualifiedName) {
          const targetNode = allNodes.find(n => n.id === edge.target);
          if (targetNode) {
            calleeIds.add(targetNode.id);
          }
        }
      }
    }

    return Array.from(calleeIds).map(id => nodeMap.get(id)).filter((n): n is Node => n !== undefined);
  }

  async getFileSymbols(filePath: string): Promise<Node[]> {
    return this.getNodesByFile(filePath);
  }

  async findDeadCode(kinds?: Node['kind'][]): Promise<Node[]> {
    const targetKinds = kinds || ['function', 'method', 'class'];
    const allNodes = await this.getAllNodes();
    const edges = await this.getAllEdges();

    const deadCode: Node[] = [];

    for (const node of allNodes) {
      if (!targetKinds.includes(node.kind)) continue;
      if (node.isExported) continue;

      const incomingRefs = edges.filter(e => e.target === node.id && e.kind !== 'contains');
      if (incomingRefs.length === 0) {
        deadCode.push(node);
      }
    }

    return deadCode;
  }

  async getCallGraph(qualifiedName: string): Promise<{ callers: Node[]; callees: Node[] }> {
    const [callers, callees] = await Promise.all([
      this.getCallers(qualifiedName),
      this.getCallees(qualifiedName),
    ]);

    return { callers, callees };
  }

  private async getAncestors(nodeId: string): Promise<Node[]> {
    const ancestors: Node[] = [];
    const visited = new Set<string>();
    let currentId = nodeId;

    while (true) {
      if (visited.has(currentId)) break;
      visited.add(currentId);

      const containingEdges = await this.getEdgesByNode(currentId);
      const containsEdge = containingEdges.find(e => e.kind === 'contains' && e.target === currentId);

      if (!containsEdge) break;

      const parentNode = await this.getNode(containsEdge.source);
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
    const edges = await this.getEdgesByNode(nodeId);
    const children: Node[] = [];

    for (const edge of edges) {
      if (edge.kind === 'contains' && edge.source === nodeId) {
        const childNode = await this.getNode(edge.target);
        if (childNode) children.push(childNode);
      }
    }

    return children;
  }

  private async getAllNodes(): Promise<Node[]> {
    return this.db.getAllNodes();
  }

  private async getAllEdges(): Promise<Edge[]> {
    return this.db.getAllEdges();
  }
}
