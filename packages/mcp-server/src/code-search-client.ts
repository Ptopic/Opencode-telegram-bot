import axios, { type AxiosInstance } from 'axios';
import type {
  SearchResult,
  ProjectStats,
  GraphNode,
  GraphContext,
  DeadCodeResult,
  IndexOptions,
  SearchOptions,
  ApiResponse,
} from './types.js';

const DEFAULT_BASE_URL = 'http://localhost:4098';

export class CodeSearchClient {
  private client: AxiosInstance;

  constructor(baseUrl: string = DEFAULT_BASE_URL) {
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Index code paths for search
   */
  async indexPaths(
    paths: string[],
    options?: IndexOptions
  ): Promise<ProjectStats> {
    const response = await this.client.post<ApiResponse<ProjectStats>>(
      '/index',
      { paths, options }
    );
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Index operation failed');
    }
    return response.data.data;
  }

  /**
   * Search for code chunks matching a query
   */
  async search(
    query: string,
    projectPath: string | undefined,
    options?: SearchOptions
  ): Promise<SearchResult[]> {
    const response = await this.client.post<ApiResponse<SearchResult[]>>(
      '/search',
      { query, projectPath, options }
    );
    if (!response.data.success) {
      throw new Error(response.data.error || 'Search operation failed');
    }
    return response.data.data || [];
  }

  /**
   * Get index statistics
   */
  async getStats(projectPath?: string): Promise<ProjectStats> {
    const response = await this.client.get<ApiResponse<ProjectStats>>('/stats', {
      params: { projectPath: projectPath ?? '' },
    });
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to get stats');
    }
    return response.data.data;
  }

  /**
   * Remove a path from the index
   */
  async removeIndex(path: string): Promise<void> {
    const response = await this.client.delete<ApiResponse<void>>(
      `/index/${encodeURIComponent(path)}`
    );
    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to remove index');
    }
  }

  /**
   * Start watching paths for changes
   */
  async startWatching(paths: string[]): Promise<void> {
    const response = await this.client.post<ApiResponse<void>>(
      '/watch/start',
      { paths }
    );
    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to start watching');
    }
  }

  /**
   * Stop watching for changes
   */
  async stopWatching(): Promise<void> {
    const response = await this.client.post<ApiResponse<void>>('/watch/stop');
    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to stop watching');
    }
  }

  /**
   * Search for graph nodes by file query
   */
  async searchGraphNodes(query: string): Promise<GraphNode[]> {
    const response = await this.client.get<ApiResponse<GraphNode[]>>(
      '/graph/search',
      { params: { q: query } }
    );
    if (!response.data.success) {
      throw new Error(response.data.error || 'Graph search failed');
    }
    return response.data.data || [];
  }

  /**
   * Get graph context for a node
   */
  async getGraphContext(id: string): Promise<GraphContext | null> {
    const response = await this.client.get<ApiResponse<GraphContext>>(
      `/graph/node/${encodeURIComponent(id)}`
    );
    if (!response.data.success) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(response.data.error || 'Failed to get graph context');
    }
    return response.data.data || null;
  }

  /**
   * Get callers of a function/method
   */
  async getGraphCallers(qualifiedName: string): Promise<GraphNode[]> {
    const response = await this.client.get<ApiResponse<GraphNode[]>>(
      `/graph/callers/${encodeURIComponent(qualifiedName)}`
    );
    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to get callers');
    }
    return response.data.data || [];
  }

  /**
   * Get callees (dependencies) of a function/method
   */
  async getGraphCallees(qualifiedName: string): Promise<GraphNode[]> {
    const response = await this.client.get<ApiResponse<GraphNode[]>>(
      `/graph/callees/${encodeURIComponent(qualifiedName)}`
    );
    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to get callees');
    }
    return response.data.data || [];
  }

  /**
   * Find dead code in the project
   */
  async findDeadCode(): Promise<DeadCodeResult[]> {
    const response = await this.client.get<ApiResponse<DeadCodeResult[]>>(
      '/graph/dead-code'
    );
    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to find dead code');
    }
    return response.data.data || [];
  }

  /**
   * Check if the API is healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.client.get('/stats');
      return true;
    } catch {
      return false;
    }
  }
}
