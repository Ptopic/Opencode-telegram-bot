import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CodeSearchClient } from './code-search-client.js';
import type {
  SearchInput,
  IndexInput,
  GraphSearchInput,
  GraphContextInput,
  GraphCallersInput,
  GraphCalleesInput,
  RemoveIndexInput,
  WatchStartInput,
} from './types.js';

const CODE_SEARCH_TOOLS = [
  {
    name: 'code_search',
    description:
      'Search for code chunks using semantic search. Returns relevant code snippets with matching scores and highlights.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query (e.g., "function that parses JSON", "React component")',
        },
        projectPath: {
          type: 'string',
          description: 'Optional project path to scope the search',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
        },
        threshold: {
          type: 'number',
          description: 'Minimum similarity score threshold (0-1)',
        },
        language: {
          type: 'string',
          description: 'Filter by programming language (e.g., "typescript", "python")',
        },
        filePath: {
          type: 'string',
          description: 'Filter by file path pattern',
        },
        chunkTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by chunk types: function, class, module, block, file',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'code_index',
    description:
      'Index code paths for search. Scans and processes files to make them searchable.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of file/directory paths to index',
        },
        extensions: {
          type: 'object',
          description: 'Map of file extensions to languages (e.g., {".ts": "typescript"})',
        },
        maxFileSize: {
          type: 'number',
          description: 'Maximum file size in bytes to index',
        },
        ignorePatterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns to ignore (e.g., "node_modules/**", "*.test.ts")',
        },
      },
      required: ['paths'],
    },
  },
  {
    name: 'code_stats',
    description:
      'Get statistics about the code index for a specific project, including total chunks, files, languages, and index size.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Project directory path to scope stats to (e.g. /workspace/my-project). Defaults to all projects if omitted.',
        },
      },
    },
  },
  {
    name: 'code_remove_index',
    description:
      'Remove a path from the code index.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path to remove from the index',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'code_watch_start',
    description:
      'Start watching paths for file changes to automatically update the index.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of paths to watch for changes',
        },
      },
      required: ['paths'],
    },
  },
  {
    name: 'code_watch_stop',
    description:
      'Stop watching paths for file changes.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'code_graph_search',
    description:
      'Search for code entities in the dependency graph by file or entity name.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for graph nodes',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'code_graph_context',
    description:
      'Get detailed context for a graph node including its callers and callees.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The graph node ID',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'code_graph_callers',
    description:
      'Find all functions/methods that call a specific function.',
    inputSchema: {
      type: 'object',
      properties: {
        qualifiedName: {
          type: 'string',
          description: 'Fully qualified name of the function (e.g., "myModule.myFunction")',
        },
      },
      required: ['qualifiedName'],
    },
  },
  {
    name: 'code_graph_callees',
    description:
      'Find all functions/methods called by a specific function.',
    inputSchema: {
      type: 'object',
      properties: {
        qualifiedName: {
          type: 'string',
          description: 'Fully qualified name of the function (e.g., "myModule.myFunction")',
        },
      },
      required: ['qualifiedName'],
    },
  },
  {
    name: 'code_dead_code',
    description:
      'Find potentially dead code (unused functions, classes, etc.) in the project.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
] as const;

class CodeSearchMCPServer {
  private server: Server;
  private client: CodeSearchClient;

  constructor() {
    this.server = new Server(
      {
        name: 'code-search-mcp-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.client = new CodeSearchClient();

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: CODE_SEARCH_TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const input = (args ?? {}) as Record<string, unknown>;

      try {
        switch (name) {
          case 'code_search':
            return await this.handleSearch(input as unknown as SearchInput);

          case 'code_index':
            return await this.handleIndex(input as unknown as IndexInput);

          case 'code_stats':
            return await this.handleStats((input as { projectPath?: string }).projectPath);

          case 'code_remove_index':
            return await this.handleRemoveIndex(input as unknown as RemoveIndexInput);

          case 'code_watch_start':
            return await this.handleWatchStart(input as unknown as WatchStartInput);

          case 'code_watch_stop':
            return await this.handleWatchStop();

          case 'code_graph_search':
            return await this.handleGraphSearch(input as unknown as GraphSearchInput);

          case 'code_graph_context':
            return await this.handleGraphContext(input as unknown as GraphContextInput);

          case 'code_graph_callers':
            return await this.handleGraphCallers(input as unknown as GraphCallersInput);

          case 'code_graph_callees':
            return await this.handleGraphCallees(input as unknown as GraphCalleesInput);

          case 'code_dead_code':
            return await this.handleDeadCode();

          default:
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: `Unknown tool: ${name}` }),
                },
              ],
              isError: true,
            };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: message }),
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async handleSearch(input: SearchInput) {
    const { query, projectPath, limit, threshold, language, filePath, chunkTypes } = input;

    const results = await this.client.search(query, projectPath, {
      limit: limit ?? 10,
      threshold,
      filters: {
        language,
        filePath,
        chunkTypes: chunkTypes as ('function' | 'class' | 'module' | 'block' | 'file')[] | undefined,
      },
    });

    const formatted = results.map((r) => ({
      file: r.chunk.filePath,
      lines: `${r.chunk.startLine}-${r.chunk.endLine}`,
      language: r.chunk.language,
      type: r.chunk.chunkType,
      score: r.score.toFixed(3),
      content: r.chunk.content,
      highlights: r.highlights,
    }));

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(formatted, null, 2) }],
    };
  }

  private async handleIndex(input: IndexInput) {
    const { paths, extensions, maxFileSize, ignorePatterns, generateSummary } = input;

    const stats = await this.client.indexPaths(paths, {
      extensions,
      maxFileSize,
      ignorePatterns,
      generateSummary,
    });

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }],
    };
  }

  private async handleStats(projectPath?: string) {
    const stats = await this.client.getStats(projectPath);

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }],
    };
  }

  private async handleRemoveIndex(input: RemoveIndexInput) {
    await this.client.removeIndex(input.path);

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true, path: input.path }) }],
    };
  }

  private async handleWatchStart(input: WatchStartInput) {
    await this.client.startWatching(input.paths);

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true, watching: input.paths }) }],
    };
  }

  private async handleWatchStop() {
    await this.client.stopWatching();

    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
    };
  }

  private async handleGraphSearch(input: GraphSearchInput) {
    const nodes = await this.client.searchGraphNodes(input.query);

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(nodes, null, 2) }],
    };
  }

  private async handleGraphContext(input: GraphContextInput) {
    const context = await this.client.getGraphContext(input.id);

    if (!context) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Node not found' }) }],
        isError: true,
      };
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(context, null, 2) }],
    };
  }

  private async handleGraphCallers(input: GraphCallersInput) {
    const callers = await this.client.getGraphCallers(input.qualifiedName);

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(callers, null, 2) }],
    };
  }

  private async handleGraphCallees(input: GraphCalleesInput) {
    const callees = await this.client.getGraphCallees(input.qualifiedName);

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(callees, null, 2) }],
    };
  }

  private async handleDeadCode() {
    const deadCode = await this.client.findDeadCode();

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(deadCode, null, 2) }],
    };
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Code Search MCP Server running on stdio');
  }
}

// Start the server
const server = new CodeSearchMCPServer();
server.run().catch((error) => {
  console.error('Failed to start MCP server:', error);
  process.exit(1);
});
