import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import { StorageDeleteError, UploadsService } from '../uploads.service';

/**
 * deleteByPrefixStrict: a exclusão de conta (LGPD) só solta a pista de uma pasta quando o bucket confirma cada
 * objeto. Aqui se confere que nenhuma falha é engolida (o deleteByPrefix antigo ignora o Errors[] do DeleteObjects).
 */
describe('UploadsService.deleteByPrefixStrict', () => {
  const env = (endpoint: string | null) => ({
    get: jest.fn((key: string, fallback?: string) => {
      const values: Record<string, string | undefined> = {
        S3_ENDPOINT: endpoint ?? undefined,
        S3_BUCKET_NAME: 'ai-generations',
        S3_PUBLIC_URL: 'https://cdn.exemplo.com',
      };
      return values[key] ?? fallback;
    }),
  });

  let send: jest.SpyInstance;
  const service = (endpoint: string | null = 'https://s3.exemplo.com') =>
    new UploadsService(env(endpoint) as never);

  type Reply = Record<string, unknown> | Error;
  /** Responde cada comando na ordem: listagem e exclusão. */
  function replies(...answers: Reply[]): void {
    for (const answer of answers) {
      if (answer instanceof Error) send.mockRejectedValueOnce(answer);
      else send.mockResolvedValueOnce(answer);
    }
  }
  const page = (keys: string[], next?: string) => ({
    Contents: keys.map((Key) => ({ Key })),
    IsTruncated: Boolean(next),
    NextContinuationToken: next,
  });
  const commands = () =>
    send.mock.calls.map(([command]) => ({
      kind: command.constructor.name,
      input: command.input,
    }));

  async function rejection(
    promise: Promise<unknown>,
  ): Promise<StorageDeleteError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(StorageDeleteError);
      return error as StorageDeleteError;
    }
    throw new Error('era para lançar StorageDeleteError');
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    send = jest.spyOn(S3Client.prototype, 'send').mockImplementation(() => {
      throw new Error('resposta não programada no teste');
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('tudo confirmado, em 2 páginas: devolve o total e pagina pela continuação', async () => {
    replies(
      page(['generations/g1/a.png', 'generations/g1/b.png'], 'token-2'),
      {
        Deleted: [
          { Key: 'generations/g1/a.png' },
          { Key: 'generations/g1/b.png' },
        ],
      },
      page(['generations/g1/c.png']),
      { Deleted: [{ Key: 'generations/g1/c.png' }] },
    );

    await expect(
      service().deleteByPrefixStrict('generations/g1/'),
    ).resolves.toBe(3);
    expect(commands()).toEqual([
      {
        kind: ListObjectsV2Command.name,
        input: {
          Bucket: 'ai-generations',
          Prefix: 'generations/g1/',
          ContinuationToken: undefined,
        },
      },
      {
        kind: DeleteObjectsCommand.name,
        input: {
          Bucket: 'ai-generations',
          Delete: {
            Objects: [
              { Key: 'generations/g1/a.png' },
              { Key: 'generations/g1/b.png' },
            ],
          },
        },
      },
      {
        kind: ListObjectsV2Command.name,
        input: {
          Bucket: 'ai-generations',
          Prefix: 'generations/g1/',
          ContinuationToken: 'token-2',
        },
      },
      {
        kind: DeleteObjectsCommand.name,
        input: {
          Bucket: 'ai-generations',
          Delete: { Objects: [{ Key: 'generations/g1/c.png' }] },
        },
      },
    ]);
  });

  it('pasta vazia: 0, sem DeleteObjects', async () => {
    replies({ Contents: [], IsTruncated: false });
    await expect(service().deleteByPrefixStrict('voices/u1/')).resolves.toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('Errors[] numa chave: segue as outras páginas e lança no fim com o que saiu e o que ficou', async () => {
    replies(
      page(['outputs/g1/a.png', 'outputs/g1/b.png'], 'token-2'),
      {
        Deleted: [{ Key: 'outputs/g1/a.png' }],
        Errors: [
          {
            Key: 'outputs/g1/b.png',
            Code: 'AccessDenied',
            Message: 'Access Denied',
          },
        ],
      },
      page(['outputs/g1/c.png']),
      { Deleted: [{ Key: 'outputs/g1/c.png' }] },
    );

    const error = await rejection(
      service().deleteByPrefixStrict('outputs/g1/'),
    );
    expect(error).toMatchObject({
      prefix: 'outputs/g1/',
      deleted: 2,
      failedKeys: ['outputs/g1/b.png'],
    });
    expect(error.message).toContain('recusou 1 objeto(s)');
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('erro sem chave no Errors[] também conta como falha', async () => {
    replies(page(['inputs/g1/a.png']), {
      Deleted: [{ Key: 'inputs/g1/a.png' }],
      Errors: [{ Code: 'InternalError' }],
    });
    const error = await rejection(service().deleteByPrefixStrict('inputs/g1/'));
    expect(error).toMatchObject({ deleted: 1, failedKeys: [] });
  });

  it('listagem falhando: lança com o que já tinha saído', async () => {
    replies(
      page(['thumbnails/g1/a.jpg'], 'token-2'),
      { Deleted: [{ Key: 'thumbnails/g1/a.jpg' }] },
      new Error('503 Slow Down'),
    );
    const error = await rejection(
      service().deleteByPrefixStrict('thumbnails/g1/'),
    );
    expect(error).toMatchObject({ deleted: 1, failedKeys: [] });
    expect(error.message).toContain(
      'Listagem da pasta "thumbnails/g1/" falhou: 503 Slow Down',
    );
  });

  it('DeleteObjects falhando: lança e nada conta como apagado', async () => {
    replies(page(['samples/g1/a.png']), new Error('socket hang up'));
    const error = await rejection(
      service().deleteByPrefixStrict('samples/g1/'),
    );
    expect(error).toMatchObject({ deleted: 0 });
    expect(error.message).toContain('socket hang up');
  });

  it('listagem truncada sem token (ou repetindo o token): lança em vez de parar no meio', async () => {
    replies(
      { Contents: [{ Key: 'workspaces/w1/a.json' }], IsTruncated: true },
      { Deleted: [{ Key: 'workspaces/w1/a.json' }] },
    );
    const noToken = await rejection(
      service().deleteByPrefixStrict('workspaces/w1/'),
    );
    expect(noToken).toMatchObject({ deleted: 1 });
    expect(noToken.message).toContain('truncada');

    send.mockReset();
    replies(
      page(['workspaces/w1/a.json'], 'mesmo-token'),
      { Deleted: [{ Key: 'workspaces/w1/a.json' }] },
      page(['workspaces/w1/b.json'], 'mesmo-token'),
      { Deleted: [{ Key: 'workspaces/w1/b.json' }] },
    );
    const loop = await rejection(
      service().deleteByPrefixStrict('workspaces/w1/'),
    );
    expect(loop).toMatchObject({ deleted: 2 });
  });

  it('pasta inválida (vazia, raiz, sem barra no fim, com espaço): lança sem falar com o bucket', async () => {
    for (const prefix of [
      '',
      '/',
      'generations',
      '/generations/g1/',
      ' generations/g1/',
      'generations/g1/ ',
    ]) {
      const error = await rejection(service().deleteByPrefixStrict(prefix));
      expect(error.message).toContain('Pasta inválida');
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('sem S3 configurado: lança (nada confirmado), ao contrário do deleteByPrefix que devolve 0', async () => {
    const unconfigured = service(null);
    const error = await rejection(
      unconfigured.deleteByPrefixStrict('generations/g1/'),
    );
    expect(error.message).toContain('S3 não configurado');
    await expect(unconfigured.deleteByPrefix('generations/g1/')).resolves.toBe(
      0,
    );
    expect(send).not.toHaveBeenCalled();
  });
});
