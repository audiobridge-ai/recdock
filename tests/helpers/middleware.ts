import { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Real streamed middleware requests without requiring an OS listening socket. */
export async function middlewareRequest(handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>, path: string, method: string, bytes: Buffer | undefined, headers: Record<string, string>) {
  const chunks: Buffer[] = [], responseHeaders = new Map<string, string>();
  class ResponseStream extends Writable {
    statusCode = 200; headersSent = false;
    setHeader(name: string, value: string) { responseHeaders.set(name.toLowerCase(), value); }
    writeHead(status: number, values: Record<string, string>) { this.statusCode = status; this.headersSent = true; for (const [name, value] of Object.entries(values)) this.setHeader(name, value); return this; }
    _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void) { this.headersSent = true; chunks.push(Buffer.from(chunk)); callback(); }
  }
  const req = Object.assign(Readable.from(bytes ? [bytes] : []), { method, url: path, headers: Object.fromEntries(Object.entries({ host: 'localhost:5173', ...headers }).map(([key, value]) => [key.toLowerCase(), value])), socket: { remoteAddress: '127.0.0.1' }, aborted: false }) as unknown as IncomingMessage;
  const res = new ResponseStream(), done = finished(res);
  await handler(req, res as unknown as ServerResponse, () => { res.statusCode = 404; res.end(); });
  await done;
  const raw = Buffer.concat(chunks); let json: any; try { json = JSON.parse(raw.toString()); } catch { /* Binary media. */ }
  return { status: res.statusCode, json, raw, headers: { get: (name: string) => responseHeaders.get(name.toLowerCase()) || null } };
}
