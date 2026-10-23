import { Logger } from '@nestjs/common';
import {
  CdnPurgeService,
  CLOUDFLARE_API_BASE,
  PURGE_BATCH_SIZE,
  type FetchLike,
} from '../cdn-purge.service';

const TOKEN = 'token-de-teste-que-nunca-aparece';
const ZONE = '0123456789abcdef0123456789abcdef';

function configWith(env: Record<string, string | undefined>) {
  return { get: (key: string) => env[key] } as never;
}

type Call = { url: string; headers: Record<string, string>; body: { files: string[] } };

function fakeFetch(
  respond: (call: Call) => { status: number; body: unknown } | Error = () => ({
    status: 200,
    body: { success: true, errors: [], result: { id: 'purge-1' } },
  }),
) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = jest.fn(async (url, init) => {
    const call: Call = { url, headers: init.headers, body: JSON.parse(init.body) as { files: string[] } };
    calls.push(call);
    const answer = respond(call);
    if (answer instanceof Error) throw answer;
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body };
  });
  return { fetchImpl, calls };
}

const url = (n: number) => `https://cdn.exemplo.com/storage/v1/object/public/ai-generations/generations/g${n}/u/out.png`;

describe('CdnPurgeService (Cloudflare)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sem token nem zona: nada sai para a rede, cada URL fica pendente com o motivo', async () => {
    const { fetchImpl } = fakeFetch();
    const cdn = new CdnPurgeService(configWith({}), fetchImpl);
    expect(cdn.configured).toBe(false);
    const outcomes = await cdn.purgeUrls([url(1), url(2)]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcomes.get(url(1))).toEqual({ status: 'pending', reason: expect.stringContaining('CLOUDFLARE_PURGE_TOKEN e CLOUDFLARE_ZONE_ID ausentes') });
    expect(outcomes.get(url(2))?.status).toBe('pending');
  });

  it.each([
    ['só o token', { CLOUDFLARE_PURGE_TOKEN: TOKEN }, 'CLOUDFLARE_ZONE_ID ausente'],
    ['só a zona', { CLOUDFLARE_ZONE_ID: ZONE }, 'CLOUDFLARE_PURGE_TOKEN ausente'],
    ['zona fora do formato', { CLOUDFLARE_PURGE_TOKEN: TOKEN, CLOUDFLARE_ZONE_ID: 'geraew.com.br' }, 'CLOUDFLARE_ZONE_ID inválido'],
  ])('%s: pendente com o motivo certo', async (_label, env, reason) => {
    const { fetchImpl } = fakeFetch();
    const cdn = new CdnPurgeService(configWith(env), fetchImpl);
    const outcomes = await cdn.purgeUrls([url(1)]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcomes.get(url(1))).toEqual({ status: 'pending', reason: expect.stringContaining(reason) });
  });

  it('com token e zona: POST purge_cache com Bearer e files, em lotes de 30; repetida conta uma vez', async () => {
    const { fetchImpl, calls } = fakeFetch();
    const cdn = new CdnPurgeService(configWith({ CLOUDFLARE_PURGE_TOKEN: TOKEN, CLOUDFLARE_ZONE_ID: ZONE }), fetchImpl);
    expect(cdn.configured).toBe(true);
    const urls = Array.from({ length: PURGE_BATCH_SIZE + 5 }, (_, i) => url(i));
    const outcomes = await cdn.purgeUrls([...urls, urls[0]]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`${CLOUDFLARE_API_BASE}/zones/${ZONE}/purge_cache`);
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].body.files).toHaveLength(PURGE_BATCH_SIZE);
    expect(calls[1].body.files).toHaveLength(5);
    expect([...outcomes.values()].every((outcome) => outcome.status === 'done')).toBe(true);
    expect(outcomes.size).toBe(urls.length);
  });

  it('Cloudflare recusa: failed com o código e a mensagem dela, sem o token', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 403, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } }));
    const cdn = new CdnPurgeService(configWith({ CLOUDFLARE_PURGE_TOKEN: TOKEN, CLOUDFLARE_ZONE_ID: ZONE }), fetchImpl);
    const outcome = (await cdn.purgeUrls([url(1)])).get(url(1));
    expect(outcome).toEqual({ status: 'failed', reason: 'Cloudflare HTTP 403: 10000 Authentication error' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });

  it('rede fora ou tempo esgotado: failed (nunca lança); 1º lote falhou não impede o 2º', async () => {
    let call = 0;
    const { fetchImpl } = fakeFetch(() => {
      call += 1;
      if (call === 1) return Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      return { status: 200, body: { success: true } };
    });
    const cdn = new CdnPurgeService(configWith({ CLOUDFLARE_PURGE_TOKEN: TOKEN, CLOUDFLARE_ZONE_ID: ZONE }), fetchImpl);
    const urls = Array.from({ length: PURGE_BATCH_SIZE + 1 }, (_, i) => url(i));
    const outcomes = await cdn.purgeUrls(urls);
    expect(outcomes.get(urls[0])).toEqual({ status: 'failed', reason: 'Cloudflare não respondeu a tempo' });
    expect(outcomes.get(urls[PURGE_BATCH_SIZE])).toEqual({ status: 'done' });
  });

  it('resposta 200 sem success: failed (não confia no status sozinho)', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { success: false, errors: [] } }));
    const cdn = new CdnPurgeService(configWith({ CLOUDFLARE_PURGE_TOKEN: TOKEN, CLOUDFLARE_ZONE_ID: ZONE }), fetchImpl);
    expect((await cdn.purgeUrls([url(1)])).get(url(1))?.status).toBe('failed');
  });

  it('URL que não é http(s) não vai para o CDN', async () => {
    const { fetchImpl, calls } = fakeFetch();
    const cdn = new CdnPurgeService(configWith({ CLOUDFLARE_PURGE_TOKEN: TOKEN, CLOUDFLARE_ZONE_ID: ZONE }), fetchImpl);
    const outcomes = await cdn.purgeUrls(['data:image/png;base64,AAAA', url(1)]);
    expect(outcomes.get('data:image/png;base64,AAAA')).toEqual({ status: 'failed', reason: 'URL inválida' });
    expect(calls[0].body.files).toEqual([url(1)]);
  });
});
