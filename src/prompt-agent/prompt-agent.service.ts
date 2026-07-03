import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { CreditsService } from '../credits/credits.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreditTransactionType } from '@prisma/client';
import { TheaimodelabChatClient, ChatPart } from '../prompt-enhancer/theaimodelab-chat.client';

const CREDIT_COST = 5;

const SYSTEM_PROMPT = `Você é um agente especializado em análise visual de imagens para criação de prompts de IA generativa voltados a conteúdo UGC (User Generated Content) realista de influenciadores.

Sua função: receber UMA imagem e retornar APENAS um JSON válido seguindo EXATAMENTE a estrutura abaixo, preenchendo cada campo com base no que você observa visualmente na imagem.

## ESTRUTURA OBRIGATÓRIA DO JSON DE SAÍDA

{
  "reference_override": "SE uma imagem de referência da pessoa for fornecida junto a este prompt ao modelo de geração, IGNORE completamente todas as descrições físicas faciais contidas em 'character_lock.face_identity' e use a identidade visual da imagem de referência como fonte única de verdade para rosto, traços, estrutura óssea e expressão característica. As descrições físicas textuais existem apenas como fallback para quando nenhuma imagem de referência estiver disponível. Demais campos (cena, roupa, iluminação, pose, câmera, acessórios) devem ser seguidos normalmente.",
  "meta": {
    "aspect_ratio": "string (9:16, 1:1, 16:9 etc)",
    "quality": "ultra_photorealistic",
    "resolution": "8k",
    "camera": "string (ex: câmera frontal do iPhone 15 Pro Max OU câmera traseira do iPhone 15 Pro Max)",
    "lens": "string (ex: 24mm grande angular, 26mm principal, 77mm telefoto)",
    "style": "string descritiva do estilo fotográfico"
  },
  "character_lock": {
    "identity_source": "",
    "face_identity": ["array com 1 string longa descrevendo rosto: formato, sobrancelhas, olhos, nariz, boca, dentes, maçãs do rosto, queixo, assimetrias naturais, SEM NOMES PRÓPRIOS"],
    "regras_de_aparencia": {
      "descricao_geral": "string (cabelo, tom de pele, textura de pele, maquiagem)",
      "marcas_e_acessorios": "string (piercings, brincos, tatuagens, colares — apenas o que está visível)"
    }
  },
  "cena": {
    "local": "string descritiva do local",
    "ambiente": ["array de strings com elementos do cenário"],
    "atmosfera": "string descrevendo o mood"
  },
  "iluminacao": {
    "tipo": "string (ex: luz natural diurna, golden hour, dia nublado)",
    "luz_principal": "string",
    "luz_de_preenchimento": "string",
    "contraste": "string (baixo, médio, médio-alto, alto)",
    "evitar": ["array com estilos de luz que NÃO devem aparecer — sempre bloquear estúdio, ring light, aparência profissional"]
  },
  "perspectiva_da_camera": {
    "pov": "string (selfie de mão próxima ao rosto, selfie de braço estendido, foto tirada por terceiro)",
    "angulo": "string (high angle, low angle, altura dos olhos)",
    "distancia": "string (close-up, meio corpo, full body shot)",
    "visibilidade_do_celular": "string (celular não visível / celular visível no reflexo)"
  },
  "assunto": {
    "genero": "string",
    "idade": "string (ex: adulto jovem 22-27)",
    "vibe": "string descritiva da personalidade transmitida",
    "textura_pele": "string detalhada sobre poros, sardas, brilho, suor",
    "expressao": {
      "olhos": "string",
      "boca": "string",
      "emocao": "string"
    },
    "pose": {
      "posicao": "string",
      "apoio": "string",
      "mao": "string detalhando o que as mãos fazem, incluindo unhas"
    },
    "roupa": {
      "blusa": {
        "tipo": "string",
        "caimento": "string",
        "detalhes": "string detalhada com cor, estampa, material"
      },
      "extra": ["array com acessórios, calça, sapato, bolsa, props na mão"]
    }
  },
  "qualidade_da_imagem": {
    "foco": "string",
    "granulacao": "string",
    "nitidez": "string (sempre enfatizar que NÃO é extremamente nítida, é lo-fi)",
    "realismo": "string (sempre enfatizar que parece foto real de iPhone postada no Instagram)",
    "artefatos_de_sensor": "string",
    "distorcao_de_lente": "string",
    "pos_processamento": "string"
  }
}

## REGRAS CRÍTICAS

1. RETORNE APENAS O JSON. Sem markdown, sem \`\`\`json, sem texto antes ou depois, sem explicações. Apenas o objeto JSON puro começando com { e terminando com }.
2. O CAMPO "reference_override" DEVE SER INCLUÍDO SEMPRE, exatamente como especificado acima, sem alterações.
3. DETECÇÃO DE SELFIE vs FOTO POR TERCEIRO: selfie tem braço visível, enquadramento apertado, leve distorção de grande angular. Foto por terceiro: full body, ângulos impossíveis de selfie. Isso define se "camera" é frontal ou traseira.
4. CHARACTER_LOCK descritivo e ancorado como fallback textual. Nunca use nomes próprios.
5. ILUMINAÇÃO em "evitar" sempre bloqueie estúdio, ring light, aparência profissional, flash estourado.
6. TEXTURA DE PELE reflete o contexto (suor, brilho, rubor, fosca).
7. ROUPA com cores precisas e textos legíveis literais.
8. NEGATIVE IMPLÍCITO em "qualidade_da_imagem": NÃO CGI, NÃO 3D, NÃO estúdio. SEMPRE foto real de celular.
9. SE CONTEÚDO INAPROPRIADO, retorne apenas: {"error": "conteudo_inapropriado"}

Analise a imagem enviada e retorne APENAS o JSON correspondente, sempre incluindo o campo "reference_override" no topo.`;

type MediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

@Injectable()
export class PromptAgentService {
  private readonly logger = new Logger(PromptAgentService.name);

  constructor(
    private readonly creditsService: CreditsService,
    private readonly prisma: PrismaService,
    private readonly chatClient: TheaimodelabChatClient,
  ) {}

  async analyzeImage(userId: string, image: string) {
    const imageBlock = await this.buildImageBlock(image);

    // Debita créditos antes; estorna em erro
    await this.creditsService.debit(
      userId,
      CREDIT_COST,
      CreditTransactionType.ADMIN_ADJUSTMENT,
      undefined,
      'Clone de Prompt — análise de imagem',
    );

    try {
      const raw = await this.callModel(imageBlock);
      let json: any;
      try {
        json = this.extractJson(raw);
      } catch (err: any) {
        const retryRaw = await this.callModel(
          imageBlock,
          `O JSON anterior falhou a validação: ${err.message}. Retorne APENAS o JSON corrigido seguindo a estrutura obrigatória.`,
        );
        json = this.extractJson(retryRaw);
      }

      if (json?.error === 'conteudo_inapropriado') {
        await this.refundSilently(userId);
        throw new BadRequestException({
          code: 'INAPPROPRIATE_CONTENT',
          message: 'Conteúdo inapropriado detectado na imagem.',
        });
      }

      const compiledPrompt = this.compileToString(json);
      return { json, compiledPrompt, creditsUsed: CREDIT_COST };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      await this.refundSilently(userId);
      this.logger.error('Falha na análise de imagem', err as any);
      throw new InternalServerErrorException({
        code: 'PROMPT_AGENT_FAILED',
        message: 'Não foi possível analisar a imagem. Créditos estornados.',
      });
    }
  }

  private async refundSilently(userId: string) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const recentDebit = await tx.creditTransaction.findFirst({
          where: {
            userId,
            type: CreditTransactionType.ADMIN_ADJUSTMENT,
            description: 'Clone de Prompt — análise de imagem',
          },
          orderBy: { createdAt: 'desc' },
        });
        const source = recentDebit?.source === 'plan' ? 'plan' : 'bonus';

        const [balance] = await tx.$queryRawUnsafe<any[]>(
          `SELECT * FROM "credit_balances" WHERE "user_id" = $1 FOR UPDATE`,
          userId,
        );
        if (!balance) return;

        await tx.creditBalance.update({
          where: { userId },
          data:
            source === 'plan'
              ? {
                  planCreditsRemaining: balance.plan_credits_remaining + CREDIT_COST,
                  planCreditsUsed: balance.plan_credits_used - CREDIT_COST,
                }
              : {
                  bonusCreditsRemaining: balance.bonus_credits_remaining + CREDIT_COST,
                },
        });

        await tx.creditTransaction.create({
          data: {
            userId,
            type: CreditTransactionType.ADMIN_ADJUSTMENT,
            amount: CREDIT_COST,
            source,
            description: 'Estorno — Clone de Prompt (falha na análise)',
          },
        });
      });
    } catch (e) {
      this.logger.error('Falha ao estornar créditos', e as any);
    }
  }

  private async buildImageBlock(image: string): Promise<ChatPart> {
    if (image.startsWith('data:')) {
      const match = image.match(/^data:(image\/(jpeg|png|webp|gif));base64,(.+)$/);
      if (!match) {
        throw new BadRequestException({
          code: 'INVALID_IMAGE_FORMAT',
          message: 'Formato de imagem inválido. Use JPEG, PNG ou WebP em base64.',
        });
      }
      const mime_type = match[1] as MediaType;
      const data = match[3];
      const sizeBytes = (data.length * 3) / 4;
      if (sizeBytes > 5 * 1024 * 1024) {
        throw new BadRequestException({
          code: 'FILE_TOO_LARGE',
          message: 'Imagem excede 5MB.',
        });
      }
      return { inline_data: { base64: data, mime_type } };
    }
    if (/^https?:\/\//i.test(image)) {
      const fetched = await this.fetchImageAsBase64(image);
      return { inline_data: fetched };
    }
    throw new BadRequestException({
      code: 'INVALID_IMAGE',
      message: 'Imagem inválida. Envie base64 data URL ou URL http(s).',
    });
  }

  private async fetchImageAsBase64(
    url: string,
  ): Promise<{ base64: string; mime_type: MediaType }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new BadRequestException({
          code: 'IMAGE_FETCH_FAILED',
          message: `Não foi possível baixar a imagem (HTTP ${res.status}).`,
        });
      }
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      const mime = contentType.split(';')[0].trim();
      const allowed: MediaType[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
      if (!allowed.includes(mime as MediaType)) {
        throw new BadRequestException({
          code: 'INVALID_IMAGE_FORMAT',
          message: `Tipo de imagem não suportado: ${mime || 'desconhecido'}.`,
        });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 5 * 1024 * 1024) {
        throw new BadRequestException({
          code: 'FILE_TOO_LARGE',
          message: 'Imagem excede 5MB.',
        });
      }
      return { base64: buf.toString('base64'), mime_type: mime as MediaType };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async callModel(imageBlock: ChatPart, extraUserText?: string): Promise<string> {
    const res = await this.chatClient.chat({
      system_instruction: SYSTEM_PROMPT,
      max_output_tokens: 4096,
      temperature: 0.2,
      messages: [
        {
          role: 'user',
          parts: [
            imageBlock,
            { text: extraUserText || 'Analise esta imagem e retorne APENAS o JSON.' },
          ],
        },
      ],
    });
    return res.text || '';
  }

  private extractJson(text: string): any {
    const cleaned = text
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    return JSON.parse(cleaned);
  }

  private compileToString(json: any): string {
    const parts: string[] = [];
    if (json.reference_override) parts.push(`[reference_override]: ${json.reference_override}`);
    const m = json.meta || {};
    parts.push(`${m.quality || 'ultra_photorealistic'}, ${m.resolution || '8k'}, ${m.camera || ''}, ${m.lens || ''}, ${m.style || ''}`);
    const cl = json.character_lock || {};
    if (Array.isArray(cl.face_identity)) parts.push(cl.face_identity.join(' '));
    if (cl.regras_de_aparencia) {
      parts.push(
        `${cl.regras_de_aparencia.descricao_geral || ''} ${cl.regras_de_aparencia.marcas_e_acessorios || ''}`,
      );
    }
    const c = json.cena || {};
    parts.push(`${c.local || ''}, ${(c.ambiente || []).join(', ')}, atmosfera ${c.atmosfera || ''}`);
    const il = json.iluminacao || {};
    parts.push(
      `iluminação ${il.tipo || ''}, ${il.luz_principal || ''}, ${il.luz_de_preenchimento || ''}, contraste ${il.contraste || ''}, evitar ${(il.evitar || []).join(', ')}`,
    );
    const p = json.perspectiva_da_camera || {};
    parts.push(`${p.pov || ''}, ${p.angulo || ''}, ${p.distancia || ''}, ${p.visibilidade_do_celular || ''}`);
    const a = json.assunto || {};
    parts.push(`${a.genero || ''} ${a.idade || ''}, vibe ${a.vibe || ''}${a.textura_pele ? ', pele ' + a.textura_pele : ''}`);
    if (a.expressao) {
      parts.push(`olhos ${a.expressao.olhos || ''}, boca ${a.expressao.boca || ''}, emoção ${a.expressao.emocao || ''}`);
    }
    if (a.pose) {
      parts.push(`pose ${a.pose.posicao || ''}, apoio ${a.pose.apoio || ''}, mãos ${a.pose.mao || ''}`);
    }
    if (a.roupa?.blusa) {
      parts.push(
        `vestindo ${a.roupa.blusa.tipo || ''} ${a.roupa.blusa.caimento || ''}, ${a.roupa.blusa.detalhes || ''}`,
      );
    }
    if (a.roupa?.extra) parts.push((a.roupa.extra || []).join(', '));
    const q = json.qualidade_da_imagem || {};
    parts.push(
      `${q.foco || ''}, ${q.granulacao || ''}, ${q.nitidez || ''}, ${q.realismo || ''}, ${q.artefatos_de_sensor || ''}, ${q.distorcao_de_lente || ''}, ${q.pos_processamento || ''}`,
    );
    return parts
      .filter(Boolean)
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .join(', ');
  }
}
