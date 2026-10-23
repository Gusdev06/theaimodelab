import { HttpStatus, InternalServerErrorException, Logger } from '@nestjs/common';
import { ContentSafetyEventKind } from '@prisma/client';
import { BusinessException } from '../../common/exceptions/business.exception';
import { assessText } from '../../content-safety/minor-guard';
import { apparentAge, DEFAULT_REFERENCE_OVERRIDE, PromptAgentService } from '../prompt-agent.service';

/** Texto fixo que a análise sempre devolve no topo do JSON (regra 2 do prompt do sistema). */
const REFERENCE_OVERRIDE =
  'SE uma imagem de referência da pessoa for fornecida junto a este prompt ao modelo de geração, IGNORE completamente todas as descrições físicas faciais contidas em \'character_lock.face_identity\' e use a identidade visual da imagem de referência como fonte única de verdade para rosto, traços, estrutura óssea e expressão característica. As descrições físicas textuais existem apenas como fallback para quando nenhuma imagem de referência estiver disponível. Demais campos (cena, roupa, iluminação, pose, câmera, acessórios) devem ser seguidos normalmente.';

/** JSON no formato do prompt do sistema, como o modelo devolve para uma selfie comum. */
function analysis(subject: Record<string, unknown>) {
  return {
    reference_override: REFERENCE_OVERRIDE,
    meta: { aspect_ratio: '9:16', quality: 'ultra_photorealistic', resolution: '8k', camera: 'iPhone câmera frontal', lens: '24mm', style: 'UGC selfie' },
    character_lock: {
      identity_source: '',
      face_identity: ['rosto oval', 'olhos castanhos amendoados', 'sobrancelhas grossas'],
      regras_de_aparencia: { descricao_geral: 'cabelo castanho longo ondulado, pele morena, maquiagem leve', marcas_e_acessorios: 'brincos de argola dourados' },
    },
    cena: { local: 'quarto', ambiente: ['cama com lençol branco', 'luz de janela'], atmosfera: 'aconchegante' },
    iluminacao: { tipo: 'natural', luz_principal: 'janela lateral', luz_de_preenchimento: 'parede branca', contraste: 'médio', evitar: ['estúdio', 'ring light'] },
    perspectiva_da_camera: { pov: 'selfie', angulo: 'levemente de cima', distancia: 'braço estendido', visibilidade_do_celular: 'celular não visível' },
    assunto: {
      genero: 'feminino',
      vibe: 'confiante e sorridente',
      textura_pele: 'poros visíveis, leve brilho',
      expressao: { olhos: 'olhando para a câmera', boca: 'sorriso leve', emocao: 'alegre' },
      pose: { posicao: 'sentada na cama', apoio: 'mão no colchão', mao: 'unhas nude' },
      roupa: { blusa: { tipo: 'regata', caimento: 'justa', detalhes: 'branca de algodão' }, extra: ['short jeans'] },
      ...subject,
    },
    qualidade_da_imagem: { foco: 'leve', granulacao: 'sutil', nitidez: 'não extremamente nítida', realismo: 'foto real de iPhone postada no Instagram', artefatos_de_sensor: 'ruído leve', distorcao_de_lente: 'grande angular leve', pos_processamento: 'nenhum' },
  };
}

/** Serviço com o modelo simulado: cada chamada devolve o próximo texto da lista (o último se repete). */
function buildReplies(replies: string[]) {
  const credits = { debit: jest.fn().mockResolvedValue(undefined) };
  const chat = { chat: jest.fn().mockResolvedValue({ text: replies[replies.length - 1] }) };
  for (const text of replies.slice(0, -1)) chat.chat.mockResolvedValueOnce({ text });
  const safety = { record: jest.fn().mockResolvedValue('evento-1') };
  const service = new PromptAgentService(credits as never, {} as never, chat as never, safety as never);
  const refund = jest.spyOn(service as unknown as { refundSilently: (id: string) => Promise<void> }, 'refundSilently').mockResolvedValue(undefined);
  jest
    .spyOn(service as unknown as { buildImageBlock: (image: string) => Promise<unknown> }, 'buildImageBlock')
    .mockResolvedValue({ inline_data: { mime_type: 'image/jpeg', data: 'AAAA' } });
  jest.spyOn((service as unknown as { logger: Logger }).logger, 'error').mockImplementation(() => undefined);
  return { service, credits, chat, safety, refund };
}

/** `root` troca campos da raiz da análise (undefined tira o campo do JSON). */
function build(subject: Record<string, unknown>, root: Record<string, unknown> = {}) {
  return buildReplies([JSON.stringify({ ...analysis(subject), ...root })]);
}

const IMAGE = 'data:image/jpeg;base64,AAAA';

/** Rótulo que o site reconhece e tira antes da trava (CLONE_PROMPT_LABEL em components/editor/GenerationError.tsx). */
const SITE_CLONE_LABEL = /^\s*\[reference_override\]:\s*/i;

describe('Clonar prompt: o prompt sempre abre com o marcador [reference_override]', () => {
  it('o texto padrão é o mesmo que o prompt do sistema manda a análise copiar', async () => {
    const { service, chat } = build({ idade: 'adulta 28-35' });
    await service.analyzeImage('user-1', IMAGE);
    expect(DEFAULT_REFERENCE_OVERRIDE).toBe(REFERENCE_OVERRIDE);
    expect(chat.chat.mock.calls[0][0].system_instruction).toContain(`"reference_override": "${DEFAULT_REFERENCE_OVERRIDE}",`);
  });

  it('com o campo na análise: abre com ele, uma vez só', async () => {
    const { service } = build({ idade: 'adulta 28-35' });
    const { compiledPrompt } = await service.analyzeImage('user-1', IMAGE);
    expect(compiledPrompt.startsWith(`[reference_override]: ${REFERENCE_OVERRIDE}, ultra_photorealistic, 8k, `)).toBe(true);
    expect(compiledPrompt).toMatch(SITE_CLONE_LABEL);
    expect(compiledPrompt.match(/\[reference_override\]/g)).toHaveLength(1);
  });

  it.each([
    ['sem o campo', undefined],
    ['nulo', null],
    ['vazio', ''],
    ['só espaços', ' \n\t '],
    ['número', 7],
    ['booleano', true],
    ['objeto', { texto: 'SE uma imagem de referência' }],
    ['lista', [REFERENCE_OVERRIDE]],
  ])('%s: abre com o texto padrão do prompt do sistema', async (_label, value) => {
    const { service, safety, refund } = build({ idade: 'adulta 28-35' }, { reference_override: value });
    const { compiledPrompt } = await service.analyzeImage('user-1', IMAGE);
    expect(compiledPrompt.startsWith(`[reference_override]: ${DEFAULT_REFERENCE_OVERRIDE}, ultra_photorealistic, 8k, `)).toBe(true);
    expect(compiledPrompt).toMatch(SITE_CLONE_LABEL);
    expect(compiledPrompt.match(/\[reference_override\]/g)).toHaveLength(1);
    expect(compiledPrompt).not.toContain('[object Object]');
    // o texto padrão não dispara a trava numa foto de adulta
    expect(refund).not.toHaveBeenCalled();
    expect(safety.record).not.toHaveBeenCalled();
  });

  it('texto diferente na análise: fica o dela, com os espaços juntados e o marcador na frente', async () => {
    const { service } = build({ idade: 'adulta 28-35' }, { reference_override: '  Use o rosto da\n foto  de referência. ' });
    const { compiledPrompt } = await service.analyzeImage('user-1', IMAGE);
    expect(compiledPrompt.startsWith('[reference_override]: Use o rosto da foto de referência., ultra_photorealistic, 8k, ')).toBe(true);
  });
});

describe('apparentAge: a idade vai para o prompt com a unidade', () => {
  it.each([
    ['16-18', 'idade aparente 16-18 anos'],
    ['adulto jovem 22-27', 'idade aparente adulto jovem 22-27 anos'],
    [17, 'idade aparente 17 anos'],
    ['25 anos', 'idade aparente 25 anos'],
    ['about 30 years', 'idade aparente about 30 years'],
    ['adulta', 'idade aparente adulta'],
    ['', ''],
    [null, ''],
  ])('%p → %p', (age, expected) => {
    expect(apparentAge(age)).toBe(expected);
  });
});

describe('Clonar prompt: idade de menor na análise', () => {
  it('foto de adulta: devolve o prompt com a idade aparente e não registra nada', async () => {
    const { service, safety, refund } = build({ idade: 'adulto jovem 25-30' });
    const result = await service.analyzeImage('user-1', 'data:image/jpeg;base64,AAAA');
    expect(result.compiledPrompt).toContain('feminino, idade aparente adulto jovem 25-30 anos');
    expect(refund).not.toHaveBeenCalled();
    expect(safety.record).not.toHaveBeenCalled();
  });

  it.each([
    ['faixa sem unidade', { idade: '16-18' }],
    ['número sozinho', { idade: 17 }],
    ['termo de menor', { idade: 'adolescente' }],
  ])('%s: recusa com CONTENT_POLICY_MINOR, estorna e registra o evento', async (_label, subject) => {
    const { service, safety, refund } = build(subject);
    const error = await service.analyzeImage('user-2', 'data:image/jpeg;base64,AAAA').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BusinessException);
    expect((error as BusinessException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect((error as BusinessException).getResponse()).toEqual(expect.objectContaining({ code: 'CONTENT_POLICY_MINOR' }));
    expect(refund).toHaveBeenCalledTimes(1);
    expect(safety.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-2',
        kind: ContentSafetyEventKind.MINOR_BLOCKED,
        route: 'POST /api/v1/prompt-agent/analyze-image',
      }),
    );
  });

  it('sem o campo reference_override: a trava barra do mesmo jeito', async () => {
    const { service, safety, refund } = build({ idade: '16-18' }, { reference_override: undefined });
    const error = await service.analyzeImage('user-2', IMAGE).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BusinessException);
    expect((error as BusinessException).getResponse()).toEqual(expect.objectContaining({ code: 'CONTENT_POLICY_MINOR' }));
    expect(refund).toHaveBeenCalledTimes(1);
    expect(safety.record).toHaveBeenCalledTimes(1);
  });

  it('o trecho gravado é a descrição da foto, sem o bloco fixo: fotos diferentes, trechos diferentes', async () => {
    // a guarda legal separa as tentativas distintas pelo trecho: com o bloco fixo na frente, todo clone barrado seria igual
    const first = build({ idade: '16-18' });
    const second = build(
      { idade: '16-18' },
      { character_lock: { face_identity: ['rosto redondo', 'olhos verdes'], regras_de_aparencia: { descricao_geral: 'cabelo ruivo curto' } } },
    );
    for (const { service } of [first, second]) await service.analyzeImage('user-2', IMAGE).catch(() => undefined);
    const [firstExcerpt, secondExcerpt] = [first, second].map(({ safety }) => safety.record.mock.calls[0][0].excerpt as string);
    expect(firstExcerpt.startsWith('ultra_photorealistic, 8k, iPhone câmera frontal, 24mm, UGC selfie, rosto oval')).toBe(true);
    expect(firstExcerpt).not.toContain('reference_override');
    expect(firstExcerpt).not.toContain(DEFAULT_REFERENCE_OVERRIDE.slice(0, 60));
    expect(firstExcerpt.length).toBeLessThanOrEqual(300);
    expect(secondExcerpt.startsWith('ultra_photorealistic, 8k, iPhone câmera frontal, 24mm, UGC selfie, rosto redondo')).toBe(true);
    expect(secondExcerpt).not.toBe(firstExcerpt);
  });
});
