// `import x = require()`: o tsconfig não tem esModuleInterop, e `import compression from` virava
// `compression_1.default(...)` (undefined) — a API caía no boot e o Swarm mantinha a versão velha (deploy de 11/11).
import compression = require('compression');
import type { Request, RequestHandler, Response } from 'express';

/**
 * Compressão gzip/br das respostas. A biblioteca de prompts (/api/v1/prompts) sai com ~1,7 MB de JSON sem
 * compressão e é a 1ª chamada da tela de Reels: comprimida cai para uma fração disso.
 *
 * SSE (/generations/events, /avatars/:id/events) fica de fora: a compressão segura os eventos no buffer até
 * fechar o bloco e o progresso da geração chegaria atrasado.
 */
export function isEventStream(req: Request, res: Response): boolean {
  const accept = String(req.headers.accept ?? '');
  const contentType = String(res.getHeader('Content-Type') ?? '');
  return accept.includes('text/event-stream') || contentType.includes('text/event-stream') || /\/events\/?$/.test(req.path);
}

export function httpCompression(): RequestHandler {
  return compression({
    threshold: 1024,
    filter: (req, res) => !isEventStream(req as Request, res as Response) && compression.filter(req, res),
  });
}
