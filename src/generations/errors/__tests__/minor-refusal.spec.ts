import { ContentSafetyError } from '../content-safety.error';
import { ProviderFailureError } from '../failure-reason';
import { isMinorRefusal } from '../minor-refusal';

/**
 * Recusa por menor encerra a geração sem desvio. O código de criança do Vertex
 * e os identificadores de moderação de menor contam sozinhos; texto que fala de
 * criança/menor só conta dentro de bloqueio de segurança/política.
 */
describe('isMinorRefusal', () => {
  describe('código de criança do Vertex', () => {
    it.each([
      ['no campo supportCode', new ContentSafetyError('blocked', '58061214')],
      ['no campo, objeto cru', { message: 'blocked', supportCode: '17301594' }],
      [
        'no texto do Veo (kie)',
        new Error(
          'Veo generation failed: The prompt could not be submitted. Support codes: 58061214',
        ),
      ],
      [
        'no detalhe técnico',
        new ProviderFailureError(
          'Não foi possível gerar o vídeo',
          'blocked, support code 17301594',
        ),
      ],
      ['na mensagem crua', 'Request blocked (support code: 17301594)'],
    ])('%s → menor', (_label, error) => {
      expect(isMinorRefusal(error)).toBe(true);
    });

    it.each([
      [
        'outro código de segurança (sexual)',
        new ContentSafetyError('blocked', '90789179'),
      ],
      [
        'código de violência no texto',
        new Error('Veo generation failed: Support codes: 61493863'),
      ],
      [
        'número maior que contém o código',
        new Error('Veo generation failed: request id 1580612149'),
      ],
    ])('%s → não é menor', (_label, error) => {
      expect(isMinorRefusal(error)).toBe(false);
    });
  });

  it.each([
    ['categoria sexual/minors', 'Content flagged: sexual/minors'],
    [
      'PUBLIC_ERROR_MINOR',
      'Gemini Omni generation failed: PUBLIC_ERROR_MINOR (400)',
    ],
    [
      'public error minor da kie (minúsculas, espaços)',
      'Veo generation failed: public error minor upload.',
    ],
    ['CSAM', 'CSAM detected'],
  ])(
    'identificador de moderação de menor vale sozinho: %s',
    (_label, message) => {
      expect(isMinorRefusal(new Error(message))).toBe(true);
    },
  );

  describe('criança/menor dentro de bloqueio de segurança', () => {
    it.each([
      [
        'ContentSafetyError da kie com "child"',
        new ContentSafetyError(
          'The image appears to contain a child (430)',
          '430',
        ),
      ],
      [
        'ContentSafetyError com "minor" substantivo',
        new ContentSafetyError('Prompt depicts a minor. (430)', '430'),
      ],
      [
        'padrão de segurança + "children"',
        new Error(
          'Grok Imagine generation failed: blocked by safety filter: children',
        ),
      ],
      [
        'vocabulário de recusa + "minors"',
        new Error(
          'Veo generation failed: request rejected, it involves minors',
        ),
      ],
      [
        '"of a minor" + "not allowed"',
        new Error(
          'Content depicting sexual content of a minor is not allowed.',
        ),
      ],
      [
        'underage + política',
        new Error(
          'Seedance failed: underage content violates our content policy',
        ),
      ],
      [
        'pt: menor de idade',
        new Error('Pedido bloqueado: conteúdo com menor de idade'),
      ],
      [
        'pt: criança',
        new ContentSafetyError(
          'A imagem ou texto viola nossas diretrizes: criança',
        ),
      ],
      ['es: niño', new Error('Solicitud rechazada: contenido con un niño')],
      ['es: menor de edad', new Error('Contenido prohibido: menor de edad')],
    ])('%s → menor', (_label, error) => {
      expect(isMinorRefusal(error)).toBe(true);
    });
  });

  describe('falso positivo', () => {
    it.each([
      [
        '"minor version" em falha técnica',
        new Error('Seedance failed: minor version mismatch, internal error'),
      ],
      [
        '"minor issue" em falha técnica',
        new Error('Kling: minor issue with the upload, please retry'),
      ],
      [
        '"minor" adjetivo dentro de bloqueio',
        new ContentSafetyError(
          'Blocked by safety filter: minor issue with formatting',
        ),
      ],
      [
        '"child process" sem bloqueio',
        new Error('spawn child process failed: EACCES permission denied'),
      ],
      [
        'bloqueio adulto comum',
        new ContentSafetyError(
          'The prompt was flagged as sexually explicit (430)',
          '430',
        ),
      ],
      [
        'entrada recusada sem menor',
        new Error('Veo generation failed: public error unsafe image upload.'),
      ],
    ])('%s → não é menor', (_label, error) => {
      expect(isMinorRefusal(error)).toBe(false);
    });

    it.each([undefined, null, '', 42, {}])(
      'entrada sem texto (%p) → não é menor',
      (value) => {
        expect(isMinorRefusal(value)).toBe(false);
      },
    );
  });
});
