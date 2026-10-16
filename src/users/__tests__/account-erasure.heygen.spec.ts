import { Logger } from '@nestjs/common';
import { HeyGenProvider } from '../../avatars/providers/heygen.provider';

/**
 * deleteAvatarGroupStrict: a exclusão de conta (LGPD) só solta o vínculo do avatar quando a HeyGen confirma. Aqui se
 * confere que nenhum erro é engolido (o deleteAvatarGroup antigo, best-effort, engolia tudo).
 */
describe('HeyGenProvider.deleteAvatarGroupStrict', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  const provider = (apiKey = 'hg-key'): HeyGenProvider =>
    new HeyGenProvider({
      get: jest.fn((key: string, fallback?: string) =>
        key === 'HEYGEN_API_KEY' ? apiKey : fallback,
      ),
    } as never);

  const response = (status: number, body = ''): Response =>
    new Response(status === 204 ? null : body, { status });

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('2xx: apagado, com DELETE na rota do grupo e a chave no cabeçalho', async () => {
    fetchMock.mockResolvedValueOnce(response(200, '{}'));
    await expect(
      provider().deleteAvatarGroupStrict('grupo/1'),
    ).resolves.toBe('deleted');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.heygen.com/v3/avatars/grupo%2F1');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(
      'hg-key',
    );
  });

  it('204 também é apagado', async () => {
    fetchMock.mockResolvedValueOnce(response(204));
    await expect(provider().deleteAvatarGroupStrict('g1')).resolves.toBe(
      'deleted',
    );
  });

  it('404: já não existia lá (conta como apagado)', async () => {
    fetchMock.mockResolvedValueOnce(response(404, 'not found'));
    await expect(provider().deleteAvatarGroupStrict('g1')).resolves.toBe(
      'not_found',
    );
  });

  it.each([401, 403, 429, 500, 503])(
    'HTTP %s: lança com o status (não engole)',
    async (status) => {
      fetchMock.mockResolvedValueOnce(response(status, 'falhou'));
      await expect(provider().deleteAvatarGroupStrict('g1')).rejects.toThrow(
        `HTTP ${status}`,
      );
    },
  );

  it('falha de rede ou timeout: lança', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(provider().deleteAvatarGroupStrict('g1')).rejects.toThrow(
      'fetch failed',
    );
  });

  it('sem HEYGEN_API_KEY ou sem id: lança sem chamar a HeyGen', async () => {
    await expect(provider('').deleteAvatarGroupStrict('g1')).rejects.toThrow();
    await expect(provider().deleteAvatarGroupStrict('  ')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
