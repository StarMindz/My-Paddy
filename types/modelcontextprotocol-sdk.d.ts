// Type declarations for @modelcontextprotocol/sdk
// These match the actual SDK interfaces to fix TypeScript resolution issues

declare module '@modelcontextprotocol/sdk' {
  export interface Implementation {
    name: string;
    version: string;
  }

  export interface ClientOptions {
    capabilities?: unknown;
    jsonSchemaValidator?: unknown;
    listChanged?: unknown;
  }

  export interface Transport {
    start(): Promise<void>;
    send(message: unknown, options?: unknown): Promise<void>;
    close(): Promise<void>;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: unknown, extra?: unknown) => void;
    sessionId?: string;
    setProtocolVersion?: (version: string) => void;
    [key: string]: unknown; // Index signature to allow additional properties
  }

  export interface ListToolsResult {
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
    }>;
  }

  export interface CallToolResult {
    content: Array<{
      type: 'text';
      text: string;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  }

  export class Client {
    constructor(info: Implementation, options?: ClientOptions);
    connect(transport: Transport): Promise<void>;
    listTools(): Promise<ListToolsResult>;
    callTool(request: { name: string; arguments?: Record<string, any> }): Promise<CallToolResult>;
    close(): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/client/streamableHttp.js' {
  import type { Transport } from '@modelcontextprotocol/sdk';

  export interface StreamableHTTPClientTransportOptions {
    requestInit?: {
      headers?: Record<string, string>;
      [key: string]: unknown;
    };
    fetch?: typeof fetch;
  }

  export class StreamableHTTPClientTransport implements Transport {
    constructor(url: URL, options?: StreamableHTTPClientTransportOptions);
    start(): Promise<void>;
    send(message: unknown, options?: unknown): Promise<void>;
    close(): Promise<void>;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: unknown, extra?: unknown) => void;
    sessionId?: string;
    setProtocolVersion?: (version: string) => void;
    [key: string]: unknown; // Index signature to match Transport interface
  }
}

