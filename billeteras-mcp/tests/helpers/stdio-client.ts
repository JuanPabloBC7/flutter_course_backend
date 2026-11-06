// Cliente MCP minimo por stdio (JSON-RPC por lineas) para probar el servidor REAL.
// No es una dependencia nueva: solo usa node:child_process.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export interface ServerOptions {
  // 'build' ejecuta build/index.js; 'src' ejecuta src/index.ts con tsx.
  entry: 'build' | 'src';
  env?: Record<string, string>;
}

export interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

interface Pending {
  resolve: (value: JsonRpcResponse) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export class StdioClient {
  readonly stdoutLines: string[] = [];
  readonly stderrChunks: string[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private nextId = 1;
  private readonly exited: Promise<number | null>;

  constructor(options: ServerOptions) {
    const args =
      options.entry === 'build' ? ['build/index.js'] : ['--import', 'tsx', 'src/index.ts'];
    this.child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf-8');
    this.child.stderr.setEncoding('utf-8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk: string) => this.stderrChunks.push(chunk));
    this.exited = new Promise((resolve) => this.child.on('close', (code) => resolve(code)));
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) {
        this.stdoutLines.push(line);
        this.dispatch(line);
      }
      index = this.buffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    const message = JSON.parse(line) as JsonRpcResponse;
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        pending.resolve(message);
      }
    }
  }

  request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout esperando respuesta a ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  notify(method: string): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  }

  // Handshake MCP: initialize + notifications/initialized.
  async initialize(): Promise<JsonRpcResponse> {
    const response = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'escenarios-client', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return response;
  }

  // Llama a una herramienta y devuelve el resultado ya extraido.
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const response = await this.request('tools/call', { name, arguments: args });
    if (response.error !== undefined) {
      return { protocolError: response.error, isError: true, text: response.error.message, json: undefined };
    }
    const result = response.result ?? {};
    const content = (result['content'] as Array<{ type: string; text: string }> | undefined) ?? [];
    const text = content[0]?.text ?? '';
    const isError = result['isError'] === true;
    let json: Record<string, unknown> | undefined;
    if (!isError) {
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = undefined;
      }
    }
    return { isError, text, json };
  }

  // Cierra stdin (el servidor debe terminar solo) y espera la salida del proceso.
  async close(): Promise<number | null> {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 5_000);
    const code = await this.exited;
    clearTimeout(timer);
    return code;
  }
}

export interface ToolOutcome {
  isError: boolean;
  text: string;
  json: Record<string, unknown> | undefined;
  protocolError?: { code: number; message: string; data?: unknown };
}

// Lanza un servidor, hace el handshake y devuelve el cliente listo.
export async function startClient(options: ServerOptions): Promise<StdioClient> {
  const client = new StdioClient(options);
  await client.initialize();
  return client;
}
