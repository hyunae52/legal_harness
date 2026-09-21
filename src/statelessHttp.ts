import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ServiceError } from './contracts.js';

export type RequestGuard = <T>(operation: () => Promise<T>) => Promise<T>;
interface LifetimeOptions { responseMs: number; responseBytes: number; release: () => void }
type Connection = Pick<Server, 'connect' | 'close'>;

/** Transport lifetime and real application work are deliberately separate. */
export async function serveStateless(req: Request, res: Response,
  makeServer: (guard: RequestGuard) => Connection, options: LifetimeOptions,
  transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })) {
  let closed = false, server: Connection | undefined, closing: Promise<void> | undefined;
  let settled!: () => void;
  const responseEnded = new Promise<void>(resolve => { settled = resolve; });
  const guard: RequestGuard = async operation => {
    if (closed || res.destroyed) throw new ServiceError(409, 'REQUEST_CLOSED');
    return operation();
  };
  const cleanup = () => {
    if (closing) return closing;
    closed = true;
    clearTimeout(timer);
    res.off('finish', end); res.off('close', end);
    options.release(); settled();
    // Mark cleanup before closing: close may synchronously emit another event.
    closing = Promise.resolve().then(() => server ? server.close() : transport.close()).catch(() => {});
    return closing;
  };
  const end = () => { void cleanup(); };
  const timer = setTimeout(() => { res.destroy(); end(); }, options.responseMs);
  timer.unref();
  res.once('finish', end); res.once('close', end);
  const send = transport.send.bind(transport);
  transport.send = async (message, sendOptions) => {
    if (closed) return;
    if (Buffer.byteLength(JSON.stringify(message)) > options.responseBytes) {
      if ('id' in message) return send({ jsonrpc: '2.0', id: message.id,
        error: { code: -32000, message: 'RESPONSE_TOO_LARGE' } }, sendOptions);
      throw new ServiceError(502, 'RESPONSE_TOO_LARGE');
    }
    return send(message, sendOptions);
  };
  try {
    if (res.destroyed || res.writableEnded) return;
    server = makeServer(guard);
    await Promise.race([server.connect(transport), responseEnded]);
    if (closed) return;
    await Promise.race([transport.handleRequest(req, res, req.body), responseEnded]);
    // A handler can return before the response has actually finished writing.
    if (!res.destroyed && !res.writableFinished) await responseEnded;
  } finally { await cleanup(); }
}
