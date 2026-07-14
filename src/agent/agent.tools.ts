/**
 * Declarações das ferramentas (function calling) expostas ao Gemini.
 *
 * Aqui vive apenas o "cardápio": nome, descrição e parâmetros. A EXECUÇÃO
 * de cada uma está em `AgentService.executeTool`, que chama os serviços
 * reais (GenerationsService, ModelsService, CreditsService, ...).
 *
 * O provider (gemini-videos) só repassa isto cru para o Gemini.
 */

// Valores de resolução aceitos pelo backend (enum Prisma Resolution).
const IMAGE_RESOLUTIONS = ['RES_1K', 'RES_2K', 'RES_4K'];
const VIDEO_RESOLUTIONS = ['RES_720P', 'RES_1080P', 'RES_4K'];

export const AGENT_TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'listar_modelos_imagem',
        description:
          'Lista os modelos de geração de IMAGEM disponíveis e ativos. Use ' +
          'para saber quais valores de "model" são válidos antes de gerar.',
        parameters: { type: 'OBJECT', properties: {} },
      },
      {
        name: 'listar_modelos_video',
        description:
          'Lista os modelos de geração de VÍDEO disponíveis e ativos (Veo etc). ' +
          'Use para saber quais valores de "model" são válidos antes de gerar.',
        parameters: { type: 'OBJECT', properties: {} },
      },
      {
        name: 'consultar_saldo',
        description:
          'Retorna o saldo de créditos do usuário (plano + bônus). Use antes ' +
          'de gerar quando quiser confirmar se há créditos suficientes.',
        parameters: { type: 'OBJECT', properties: {} },
      },
      {
        name: 'melhorar_prompt',
        description:
          'Otimiza um prompt do usuário para maior qualidade de geração. ' +
          'Grátis. Use quando o prompt do usuário for curto/vago antes de gerar.',
        parameters: {
          type: 'OBJECT',
          properties: {
            prompt: {
              type: 'STRING',
              description: 'Prompt original do usuário',
            },
            tipo: {
              type: 'STRING',
              enum: ['IMAGE', 'VIDEO'],
              description: 'Se o prompt é para imagem ou vídeo',
            },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'gerar_imagem',
        description:
          'Dispara a geração de uma imagem. Retorna { id, status, creditsConsumed }. ' +
          'A geração é assíncrona — use consultar_geracao com o id para acompanhar. ' +
          'Consome créditos.',
        parameters: {
          type: 'OBJECT',
          properties: {
            prompt: { type: 'STRING', description: 'Descrição da imagem' },
            model: {
              type: 'STRING',
              description:
                'Slug do modelo (obtenha via listar_modelos_imagem). ' +
                'Ex: gemini-3-pro-image-preview',
            },
            resolution: {
              type: 'STRING',
              enum: IMAGE_RESOLUTIONS,
              description: 'Resolução da imagem',
            },
            aspect_ratio: {
              type: 'STRING',
              enum: [
                '1:1',
                '9:16',
                '16:9',
                '3:4',
                '4:3',
                '4:5',
                '5:4',
                '3:2',
                '2:3',
                '21:9',
              ],
              description: 'Proporção (opcional)',
            },
            image_indexes: {
              type: 'ARRAY',
              items: { type: 'NUMBER' },
              description:
                'Índices das imagens anexadas pelo usuário a usar como ' +
                'referência para edição (image-to-image). Opcional.',
            },
          },
          required: ['prompt', 'model', 'resolution'],
        },
      },
      {
        name: 'gerar_video_texto',
        description:
          'Dispara a geração de um vídeo a partir de texto (text-to-video). ' +
          'Retorna { id, status, creditsConsumed }. Assíncrono — acompanhe com ' +
          'consultar_geracao. Consome créditos.',
        parameters: {
          type: 'OBJECT',
          properties: {
            prompt: { type: 'STRING', description: 'Descrição do vídeo' },
            model: {
              type: 'STRING',
              description:
                'Slug do modelo de vídeo (via listar_modelos_video). ' +
                'Ex: veo-3.1-fast-generate-001',
            },
            resolution: {
              type: 'STRING',
              enum: VIDEO_RESOLUTIONS,
              description: 'Resolução do vídeo',
            },
            aspect_ratio: {
              type: 'STRING',
              enum: ['16:9', '9:16'],
              description: 'Proporção (opcional, padrão 16:9)',
            },
            duration_seconds: {
              type: 'NUMBER',
              description: 'Duração em segundos (opcional, padrão 8)',
            },
            generate_audio: {
              type: 'BOOLEAN',
              description: 'Gerar áudio junto (opcional, padrão true)',
            },
            negative_prompt: {
              type: 'STRING',
              description: 'O que evitar no vídeo (opcional)',
            },
          },
          required: ['prompt', 'model', 'resolution'],
        },
      },
      {
        name: 'gerar_video_imagem',
        description:
          'Dispara a geração de um vídeo a partir de uma imagem anexada como ' +
          'primeiro frame (image-to-video). Retorna { id, status, creditsConsumed }. ' +
          'Assíncrono — acompanhe com consultar_geracao. Consome créditos.',
        parameters: {
          type: 'OBJECT',
          properties: {
            prompt: {
              type: 'STRING',
              description: 'Descrição do movimento/cena',
            },
            image_index: {
              type: 'NUMBER',
              description:
                'Índice da imagem anexada pelo usuário a usar como primeiro frame.',
            },
            model: {
              type: 'STRING',
              description:
                'Slug do modelo de vídeo (via listar_modelos_video). ' +
                'Opcional (padrão veo-3.1-generate-001).',
            },
            resolution: {
              type: 'STRING',
              enum: VIDEO_RESOLUTIONS,
              description: 'Resolução do vídeo',
            },
            aspect_ratio: {
              type: 'STRING',
              enum: ['16:9', '9:16'],
              description: 'Proporção (opcional)',
            },
            duration_seconds: {
              type: 'NUMBER',
              description: 'Duração em segundos (opcional, padrão 8)',
            },
            generate_audio: {
              type: 'BOOLEAN',
              description: 'Gerar áudio junto (opcional, padrão true)',
            },
          },
          required: ['prompt', 'image_index', 'resolution'],
        },
      },
      {
        name: 'consultar_geracao',
        description:
          'Consulta o status e o resultado (URLs de saída) de uma geração pelo id. ' +
          'Use para acompanhar gerações disparadas. Grátis.',
        parameters: {
          type: 'OBJECT',
          properties: {
            generation_id: { type: 'STRING', description: 'ID da geração' },
          },
          required: ['generation_id'],
        },
      },
    ],
  },
];

export const AGENT_SYSTEM_PROMPT = `Você é o assistente de criação do The AI Model Lab, uma plataforma de geração de imagens e vídeos com IA.

Seu trabalho é conversar com o usuário e, quando ele pedir para criar conteúdo, usar as ferramentas disponíveis para executar de verdade — listar modelos, checar saldo, melhorar prompts e disparar gerações.

Regras:
- Sempre que o usuário der um prompt curto ou vago para uma geração, use "melhorar_prompt" antes de gerar (é grátis).
- Se não tiver certeza de qual "model" usar, chame "listar_modelos_imagem" ou "listar_modelos_video" e escolha um slug válido.
- As gerações são ASSÍNCRONAS: as ferramentas de gerar retornam um id e status inicial (normalmente PROCESSING). NÃO afirme que o vídeo/imagem já está pronto. Informe o id e explique que está processando; se o usuário pedir, use "consultar_geracao" para checar.
- As imagens que o usuário anexou estão disponíveis por índice, começando em 0. Para editar uma imagem (image-to-image) ou animá-la (image-to-video), passe o índice correspondente (image_indexes / image_index). Nunca invente base64.
- Se uma ferramenta retornar um campo "error", explique o problema ao usuário em linguagem simples e, se fizer sentido, tente corrigir os parâmetros e chamar de novo.
- Gerar consome créditos do usuário. Se o saldo for claramente insuficiente, avise antes em vez de tentar gerar.
- Responda sempre em português, de forma direta e amigável.`;
