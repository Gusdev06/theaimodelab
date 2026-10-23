import { AgentService } from '../agent.service';

/**
 * /api/v1/agent/chat chama o GenerationsService direto (sem passar pelos controllers de geração): o prompt que o
 * LLM escreve tem de passar pela trava de menor e a foto do usuário nunca vai a modelo sem censura por aqui.
 */
function setup(functionCalls: { name: string; args: Record<string, unknown> }[]) {
  const generations = {
    generateImage: jest.fn().mockResolvedValue({ id: 'gen-1', status: 'PENDING' }),
    generateTextToVideo: jest.fn().mockResolvedValue({ id: 'gen-2', status: 'PENDING' }),
    generateImageToVideo: jest.fn().mockResolvedValue({ id: 'gen-3', status: 'PENDING' }),
    findById: jest.fn(),
  };
  const promptEnhancer = { enhance: jest.fn().mockResolvedValue({ prompt: 'ok', negativePrompt: '' }) };
  const contentSafety = { record: jest.fn().mockResolvedValue('evt-1') };
  let call = 0;
  const chatClient = {
    // 1ª volta: o "LLM" pede as ferramentas; 2ª volta: responde em texto
    chat: jest.fn(async () => (call++ === 0 ? { functionCalls, parts: [] } : { text: 'feito', functionCalls: [] })),
  };
  const service = new AgentService(
    chatClient as never,
    promptEnhancer as never,
    generations as never,
    { listImageModels: jest.fn(), listVideoModels: jest.fn() } as never,
    { getBalance: jest.fn() } as never,
    contentSafety as never,
  );
  return { service, generations, promptEnhancer, contentSafety };
}

const photo = { base64: 'iVBORw0KGgo'.padEnd(2000, 'Ab1'), mime_type: 'image/png' };

describe('AgentService · trava de segurança', () => {
  it('prompt com menor: o provedor nunca é chamado e o bloqueio fica registrado', async () => {
    const { service, generations, contentSafety } = setup([
      { name: 'gerar_imagem', args: { prompt: 'garota de 15 anos na praia', model: 'gpt-image-2', resolution: 'RES_2K' } },
    ]);
    const out = await service.chat('user-1', { message: 'gera uma foto' } as never);
    expect(generations.generateImage).not.toHaveBeenCalled();
    expect(out.toolCalls[0].result).toMatchObject({ code: 'CONTENT_POLICY_MINOR' });
    expect(contentSafety.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'MINOR_BLOCKED', route: 'agent:gerar_imagem' }));
  });

  it('melhorar prompt com menor também é recusado', async () => {
    const { service, promptEnhancer } = setup([{ name: 'melhorar_prompt', args: { prompt: 'teen girl in bikini' } }]);
    const out = await service.chat('user-1', { message: 'melhora' } as never);
    expect(promptEnhancer.enhance).not.toHaveBeenCalled();
    expect(out.toolCalls[0].result).toMatchObject({ code: 'CONTENT_POLICY_MINOR' });
  });

  it('despir pelo agente é recusado (sem tela de atestado)', async () => {
    const { service, generations, contentSafety } = setup([
      { name: 'gerar_imagem', args: { prompt: 'retrato', model: 'deepdeep', resolution: 'RES_2K', image_indexes: [0] } },
    ]);
    const out = await service.chat('user-1', { message: 'x', images: [photo] } as never);
    expect(generations.generateImage).not.toHaveBeenCalled();
    expect(out.toolCalls[0].result).toMatchObject({ code: 'CONSENT_REQUIRED' });
    expect(contentSafety.record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'CONSENT_MISSING' }));
  });

  it('foto do usuário em modelo sem censura (imagem e vídeo) é recusada', async () => {
    const { service, generations } = setup([
      { name: 'gerar_imagem', args: { prompt: 'mesma mulher, 30 anos', model: 'sem-censura', resolution: 'RES_2K', image_indexes: [0] } },
      { name: 'gerar_video_imagem', args: { prompt: 'ela dança', model: 'wavespeed-seedance-spicy', resolution: 'RES_720P', image_index: 0 } },
    ]);
    await service.chat('user-1', { message: 'x', images: [photo] } as never);
    expect(generations.generateImage).not.toHaveBeenCalled();
    expect(generations.generateImageToVideo).not.toHaveBeenCalled();
  });

  it('pedido adulto comum segue para a geração', async () => {
    const { service, generations } = setup([
      { name: 'gerar_imagem', args: { prompt: 'a 30 year old woman, golden hour', model: 'sem-censura', resolution: 'RES_2K' } },
      { name: 'gerar_video_imagem', args: { prompt: 'slow zoom', model: 'veo3-fast', resolution: 'RES_720P', image_index: 0 } },
    ]);
    await service.chat('user-1', { message: 'x', images: [photo] } as never);
    expect(generations.generateImage).toHaveBeenCalledTimes(1);
    expect(generations.generateImageToVideo).toHaveBeenCalledTimes(1);
  });
});
