import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer } from "node:http";
import { z } from 'zod';
import { AuthManager } from './auth/auth-manager.js';
import { AuthenticationError } from './auth/types.js';
import { allTools } from './tool-configs.js';
import { allPrompts } from './prompt-configs.js';
import { YouTubeClient } from './youtube/youtube-client.js';

// Initialize auth manager
const authManager = new AuthManager();

// Cache for YouTube client
let youtubeClientCache: YouTubeClient | null = null;

// Helper function to get YouTube client
async function getYouTubeClient(): Promise<YouTubeClient> {
  try {
    // Return cached client if available
    if (youtubeClientCache) {
      return youtubeClientCache;
    }

    const auth = await authManager.getAuthClient();
    youtubeClientCache = new YouTubeClient(auth);
    return youtubeClientCache;
  } catch (error) {
    // Clear cache on error
    youtubeClientCache = null;
    
    if (error instanceof AuthenticationError) {
      throw new Error(`Authentication failed: ${error.message}`);
    }
    throw new Error(`Failed to get YouTube client: ${error}`);
  }
}

// Helper function to clear YouTube client cache
function clearYouTubeClientCache(): void {
  youtubeClientCache = null;
}

// Build a fresh MCP server (stateless HTTP: one per request)
function createServer(): McpServer {
  const server = new McpServer({
    name: "youtube-analytics-mcp",
    version: "1.0.0",
    capabilities: { resources: {}, tools: {}, prompts: {} },
  });

  // Register all tools
  allTools.forEach((toolConfig: any) => {
    
    server.registerTool(
      toolConfig.name,
      {
        description: toolConfig.description,
        inputSchema: toolConfig.schema?.shape || {},
      },
      async (params: any) => {
        try {
          console.error(`Executing tool: ${toolConfig.name}`);
          return await toolConfig.handler(params, { 
            authManager, 
            getYouTubeClient, 
            clearYouTubeClientCache 
          });
        } catch (error) {
          console.error(`Error in tool ${toolConfig.name}:`, error);
          return {
            content: [{
              type: "text",
              text: `Error executing ${toolConfig.name}: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
  });


  // Register all prompts
  allPrompts.forEach((promptConfig: any) => {
    
    server.registerPrompt(
      promptConfig.name,
      {
        title: promptConfig.title,
        description: promptConfig.description,
        argsSchema: promptConfig.argsSchema,
      },
      async (args: any) => {
        try {
          console.error(`Executing prompt: ${promptConfig.name}`);
          return await promptConfig.handler(args);
        } catch (error) {
          console.error(`Error in prompt ${promptConfig.name}:`, error);
          return {
            content: [{
              type: "text",
              text: `Error executing ${promptConfig.name}: ${error instanceof Error ? error.message : String(error)}`
            }],
            isError: true
          };
        }
      }
    );
  });



  return server;
}

const PORT = Number(process.env.PORT) || 8080;

function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!chunks.length) return resolve(undefined);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

const httpServer = createHttpServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0];

  if (path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (path !== "/mcp") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const rpcError = (status: number, code: number, message: string) => {
    if (res.headersSent) return;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
  };

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    rpcError(405, -32000, "Method not allowed (stateless server; use POST)");
    return;
  }

  try {
    const body = await readBody(req);
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error("Error handling /mcp request:", error);
    rpcError(500, -32603, "Internal server error");
  }
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.error(`YouTube Analytics MCP Server listening on 0.0.0.0:${PORT} (/mcp, /health)`);
});

function shutdown() {
  console.error("Shutting down server...");
  httpServer.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
