import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { CreditsService } from '../credits/credits.service';
import { PrismaService } from '../prisma/prisma.service';
import { ContentSafetyEventKind, CreditTransactionType } from '@prisma/client';
import { TheaimodelabChatClient, ChatPart } from '../prompt-enhancer/theaimodelab-chat.client';
import { fitImageForVision } from '../common/utils/vision-image';
import { createHash } from 'crypto';
import { BusinessException } from '../common/exceptions/business.exception';
import { ContentSafetyService } from '../content-safety/content-safety.service';
import { assessText, MinorAssessment } from '../content-safety/minor-guard';
import { canonical } from '../content-safety/adult-only-rules';
import { OpenRouterVisionClient } from './openrouter-vision.client';

const CREDIT_COST = 5;

/** Rota do clonador na trilha de segurança (mesmo formato do interceptor). */
const SAFETY_ROUTE = 'POST /api/v1/prompt-agent/analyze-image';

/** Impressão curta da imagem analisada (12 hex do sha256): separa as tentativas no registro sem guardar a foto. */
function imageFingerprint(imageBlock: ChatPart, image: string): string {
  return createHash('sha256')
    .update(imageBlock.inline_data?.base64 ?? image)
    .digest('hex')
    .slice(0, 12);
}

/**
 * Idade como a análise devolve ("adulto jovem 22-27", "16-18", 17). No prompt ela vai como "idade aparente" e com a
 * unidade: sem ela, "feminino 16-18" passava pela trava de menor como um número qualquer.
 */
export function apparentAge(age: unknown): string {
  const text =
    typeof age === 'number' && Number.isFinite(age) ? String(age) : typeof age === 'string' ? age.trim() : '';
  if (!text) return '';
  const unit = /\d\s*$/.test(text) && !/\b(?:anos?|years?|yrs?|años?)\b/i.test(text) ? ' anos' : '';
  return `idade aparente ${text}${unit}`;
}

/**
 * Bloco que abre todo prompt clonado: quando a foto da pessoa vai junto, o modelo de geração segue o rosto da foto, não o
 * descrito no texto. É o texto que o prompt do sistema manda a análise copiar sem mudança e o padrão quando ela não
 * devolve o campo.
 */
export const DEFAULT_REFERENCE_OVERRIDE =
  "SE uma imagem de referência da pessoa for fornecida junto a este prompt ao modelo de geração, IGNORE completamente todas as descrições físicas faciais contidas em 'character_lock.face_identity' e use a identidade visual da imagem de referência como fonte única de verdade para rosto, traços, estrutura óssea e expressão característica. As descrições físicas textuais existem apenas como fallback para quando nenhuma imagem de referência estiver disponível. Demais campos (cena, roupa, iluminação, pose, câmera, acessórios) devem ser seguidos normalmente.";

/** Rótulo na frente do prompt clonado: é por ele que o site reconhece o prompt feito para ir com a foto de uma pessoa. */
const REFERENCE_OVERRIDE_LABEL = '[reference_override]:';

/** Texto do bloco: o que a análise devolveu ou, sem texto no campo (ausente, vazio ou de outro tipo), o padrão. */
function referenceOverrideText(value: unknown): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text || DEFAULT_REFERENCE_OVERRIDE;
}

/** A análise com o bloco no topo: no modo JSON, é por ele que o site reconhece o prompt feito para ir com a foto. */
function withReferenceOverride(json: Record<string, unknown>): Record<string, unknown> {
  const { reference_override: value, ...rest } = json;
  return { reference_override: referenceOverrideText(value), ...rest };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Letra que segue fora do alfabeto latino na forma canônica (grego "Φ", devanágari; o "α", que parece "a", vira "a"). */
const FOREIGN_LETTER = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

/**
 * Trava de menor num texto da análise. A análise copia o texto legível da foto (camiseta, placa) no alfabeto dele, e com
 * letra de alfabeto sem lista a trava parava em 'script', antes da idade: a descrição da pessoa, em português, é
 * conferida de novo sem essas letras.
 */
function assessAnalysisText(text: string): MinorAssessment {
  const verdict = assessText(text);
  if (verdict.reason !== 'script') return verdict;
  return assessText(text.replace(/\p{L}/gu, (char) => (FOREIGN_LETTER.test(canonical(char)) ? ' ' : char)));
}

/** Forma do que o describePhoto põe no prompt clonado: 'text' = texto ou número, 'list' = lista de textos. */
type Rendered = 'text' | 'list' | { readonly [key: string]: Rendered };

const RENDERED: Rendered = {
  reference_override: 'text',
  meta: { quality: 'text', resolution: 'text', camera: 'text', lens: 'text', style: 'text' },
  character_lock: {
    face_identity: 'list',
    regras_de_aparencia: { descricao_geral: 'text', marcas_e_acessorios: 'text' },
  },
  cena: { local: 'text', ambiente: 'list', atmosfera: 'text' },
  iluminacao: { tipo: 'text', luz_principal: 'text', luz_de_preenchimento: 'text', contraste: 'text', evitar: 'list' },
  perspectiva_da_camera: { pov: 'text', angulo: 'text', distancia: 'text', visibilidade_do_celular: 'text' },
  assunto: {
    genero: 'text',
    idade: 'text',
    vibe: 'text',
    textura_pele: 'text',
    expressao: { olhos: 'text', boca: 'text', emocao: 'text' },
    pose: { posicao: 'text', apoio: 'text', mao: 'text' },
    roupa: { blusa: { tipo: 'text', caimento: 'text', detalhes: 'text' }, extra: 'list' },
  },
  qualidade_da_imagem: {
    foco: 'text',
    granulacao: 'text',
    nitidez: 'text',
    realismo: 'text',
    artefatos_de_sensor: 'text',
    distorcao_de_lente: 'text',
    pos_processamento: 'text',
  },
};

/** Campo de idade com outro nome ou fora do lugar ("idade_aparente", "faixa_etaria", "apparentAge", "edad"). */
const AGE_FIELD = /(?:^|[\s_-])(?:idades?|ages?|aged|edad(?:es)?|faixa[\s_-]*et[aá]ria|et[aá]ri[ao]s?)(?:$|[\s_-])/i;

function isAgeField(key: string): boolean {
  return AGE_FIELD.test(key.replace(/(\p{Ll})(\p{Lu})/gu, '$1_$2'));
}

/** Textos de uma parte da análise que o prompt não leva; a idade vai com a unidade, como no prompt. */
function leftoverLines(value: unknown, age: boolean, lines: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) leftoverLines(item, age, lines);
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) leftoverLines(entry, age || isAgeField(key), lines);
    return;
  }
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : typeof value === 'number' ? String(value) : '';
  if (text) lines.push(age ? apparentAge(text) : text);
}

/**
 * O que a análise disse e o prompt clonado não leva: campo com outro nome, fora do lugar ou de outro tipo (a idade num
 * objeto, o rosto num texto, duas pessoas numa lista). Chega à cliente no modo JSON, então passa pela trava à parte.
 */
function unrenderedText(json: Record<string, unknown>): string {
  const lines: string[] = [];
  const walk = (value: unknown, shape: Rendered | undefined, age: boolean): void => {
    if (shape === 'text' && (typeof value === 'string' || typeof value === 'number')) return;
    if (shape === 'list' && Array.isArray(value)) {
      for (const item of value) walk(item, 'text', age);
      return;
    }
    if (typeof shape === 'object' && isRecord(value)) {
      for (const [key, entry] of Object.entries(value)) {
        walk(entry, Object.prototype.hasOwnProperty.call(shape, key) ? shape[key] : undefined, age || isAgeField(key));
      }
      return;
    }
    leftoverLines(value, age, lines);
  };
  walk(json, RENDERED, false);
  return lines.join('\n');
}

const SYSTEM_PROMPT = `Você é um agente especializado em análise visual de imagens para criação de prompts de IA generativa voltados a conteúdo UGC (User Generated Content) realista de influenciadores.

Sua função: receber UMA imagem e retornar APENAS um JSON válido seguindo EXATAMENTE a estrutura abaixo, preenchendo cada campo com base no que você observa visualmente na imagem.

## ESTRUTURA OBRIGATÓRIA DO JSON DE SAÍDA

{
  "reference_override": "${DEFAULT_REFERENCE_OVERRIDE}",
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

// Plano B (OpenRouter) pra imagem que o Gemini recusa: mesma estrutura, mas
// nudez e lingerie de adulto são descritas literalmente. Menor continua barrado.
const ADULT_RULES = `9. A PLATAFORMA É 18+ E TODAS AS PESSOAS SÃO ADULTAS. Nudez, lingerie e poses sensuais são permitidas: descreva corpo, nudez parcial ou total e roupa íntima de forma literal e detalhada (use "roupa" para o que veste ou "nua"/"seminua"), sem censurar, suavizar ou moralizar.
10. "assunto.idade" SEMPRE começa com "adulta" ou "adulto" e uma faixa de 21 anos ou mais. NUNCA use "jovem", "menina", "garota", "novinha", "teen", "young", "girl" ou equivalentes em nenhum campo.
11. SE A PESSOA PUDER SER MENOR DE IDADE (traços infantis, corpo pré-adolescente, uniforme escolar, contexto infantil), retorne apenas: {"error": "menor_de_idade"}`;

const ADULT_SYSTEM_PROMPT = SYSTEM_PROMPT.replace(
  '9. SE CONTEÚDO INAPROPRIADO, retorne apenas: {"error": "conteudo_inapropriado"}',
  ADULT_RULES,
);

// Rede de segurança: termos que lembram menor e travam o filtro do gerador.
const MINOR_TERMS: [RegExp, string][] = [
  [/\byoung (woman|lady)\b/gi, 'adult woman'],
  [/\byoung man\b/gi, 'adult man'],
  [/\b(girl|teen|teenager)\b/gi, 'woman'],
  [/\b(menina|garota|novinha)\b/gi, 'mulher adulta'],
  [/\b(adult[oa]) jovem\b/gi, '$1'],
  [/\bjovem\b/gi, 'adulta'],
];

type MediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

@Injectable()
export class PromptAgentService {
  private readonly logger = new Logger(PromptAgentService.name);

  constructor(
    private readonly creditsService: CreditsService,
    private readonly prisma: PrismaService,
    private readonly chatClient: TheaimodelabChatClient,
    private readonly openRouter: OpenRouterVisionClient,
    private readonly safety: ContentSafetyService,
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
      let json: any;
      try {
        json = await this.analyzeWith((extra) => this.callModel(imageBlock, extra));
      } catch (err) {
        // Gemini bloqueado por segurança costuma vir vazio ou fora do JSON.
        if (!this.openRouter.enabled) throw err;
        this.logger.warn(`Gemini falhou, indo pro OpenRouter: ${(err as Error).message}`);
        json = { error: 'conteudo_inapropriado' };
      }

      if (json?.error === 'conteudo_inapropriado' && this.openRouter.enabled) {
        json = await this.analyzeWith((extra) => this.callAdultModel(imageBlock, extra));
        // o próprio modelo 18+ viu menor na foto: a recusa de menor, com o registro (nota de merge do beedf6a). Sem
        // descrição para o trecho, ele leva a impressão da imagem: a guarda legal conta as tentativas distintas pelo
        // trecho, e a mesma foto mandada de novo conta uma vez só
        if (json?.error === 'menor_de_idade') {
          await this.blockMinor(userId, 'menor_de_idade', `análise recusou a foto (menor_de_idade) · imagem ${imageFingerprint(imageBlock, image)}`);
        }
      }

      if (json?.error) {
        await this.refundSilently(userId);
        throw new BadRequestException({
          code: 'INAPPROPRIATE_CONTENT',
          message: 'Conteúdo inapropriado detectado na imagem.',
        });
      }

      // A análise descreve a pessoa da foto: idade ou termo de menor recusa aqui, com a mesma trava das gerações, antes
      // de o prompt chegar à cliente (o pedido só tinha a imagem, que o interceptor não lê), e antes da troca de termos
      // do plano B (stripMinorTerms), que esconderia "menina", "novinha" ou "teen" atrás de "mulher adulta". O que a
      // análise disse fora do prompt chega a ela no modo JSON e passa pela mesma trava. O trecho do registro é a
      // descrição da foto, sem o bloco fixo que abre todo prompt clonado: com ele, todo bloqueio teria o mesmo trecho, e
      // a guarda legal separa as tentativas distintas pelo trecho.
      const description = this.describePhoto(json);
      const leftover = unrenderedText(json);
      const checks = [
        { text: this.compileToString(json), excerpt: description },
        { text: leftover, excerpt: `${leftover}, ${description}` },
      ];
      for (const { text, excerpt } of checks) {
        const verdict = assessAnalysisText(text);
        if (!verdict.blocked) continue;
        // grande demais ou num alfabeto que a trava não lê nem sem as letras de fora: nunca chega à cliente sem leitura
        if (verdict.reason !== 'age' && verdict.reason !== 'term') {
          throw new Error(`análise que a trava não conseguiu ler (${verdict.reason})`);
        }
        await this.blockMinor(userId, verdict.match ?? null, excerpt);
      }

      json = this.stripMinorTerms(json);
      const compiledPrompt = this.compileToString(json);
      return { json: withReferenceOverride(json), compiledPrompt, creditsUsed: CREDIT_COST };
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof BusinessException) throw err;
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
      // Sem teto de tamanho: imagem grande é reduzida antes de ir pro modelo.
      const fitted = await fitImageForVision(Buffer.from(match[3], 'base64'), match[1]);
      return {
        inline_data: {
          base64: fitted.buffer.toString('base64'),
          mime_type: fitted.mimeType as MediaType,
        },
      };
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
      const fitted = await fitImageForVision(Buffer.from(await res.arrayBuffer()), mime);
      return { base64: fitted.buffer.toString('base64'), mime_type: fitted.mimeType as MediaType };
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

  /** Recusa de menor do Clonar prompt: estorna, registra o evento (a guarda legal conta as tentativas) e responde 422. */
  private async blockMinor(userId: string, match: string | null, excerpt: string): Promise<never> {
    await this.refundSilently(userId);
    await this.safety.record({
      userId,
      kind: ContentSafetyEventKind.MINOR_BLOCKED,
      route: SAFETY_ROUTE,
      match,
      excerpt: excerpt.slice(0, 300),
    });
    throw new BusinessException('CONTENT_POLICY_MINOR');
  }

  /** Chama o modelo e, se o JSON vier quebrado, pede a correção uma vez. */
  private async analyzeWith(call: (extraUserText?: string) => Promise<string>): Promise<any> {
    const raw = await call();
    try {
      return this.extractJson(raw);
    } catch (err: any) {
      const retryRaw = await call(
        `O JSON anterior falhou a validação: ${err.message}. Retorne APENAS o JSON corrigido seguindo a estrutura obrigatória.`,
      );
      return this.extractJson(retryRaw);
    }
  }

  private async callAdultModel(imageBlock: ChatPart, extraUserText?: string): Promise<string> {
    if (!imageBlock.inline_data) throw new Error('Imagem ausente para o OpenRouter');
    return this.openRouter.describe({
      system: ADULT_SYSTEM_PROMPT,
      image: imageBlock.inline_data,
      text: extraUserText || 'Analise esta imagem e retorne APENAS o JSON.',
    });
  }

  private stripMinorTerms(json: any): any {
    let text = JSON.stringify(json);
    for (const [re, to] of MINOR_TERMS) text = text.replace(re, to);
    return JSON.parse(text);
  }

  private extractJson(text: string): Record<string, unknown> {
    const cleaned = text
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```$/i, '')
      .trim();
    const parsed: unknown = JSON.parse(cleaned);
    // lista ou valor solto escapava da trava (o prompt saía sem nada da análise e a lista ia inteira para a cliente)
    if (!isRecord(parsed)) throw new Error('a resposta precisa ser um único objeto JSON');
    return parsed;
  }

  /**
   * Prompt clonado: SEMPRE abre com "[reference_override]: …", mesmo quando a análise não devolve o campo, para o site
   * reconhecer o prompt de identidade (o rosto de uma foto enviada) e nunca levá-lo a um modelo sem censura.
   */
  private compileToString(json: any): string {
    return `${REFERENCE_OVERRIDE_LABEL} ${referenceOverrideText(json.reference_override)}, ${this.describePhoto(json)}`;
  }

  /** O que a análise disse da foto (câmera, rosto, aparência, cena, luz, pessoa, roupa e qualidade), sem o bloco fixo. */
  private describePhoto(json: any): string {
    const parts: string[] = [];
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
    const age = apparentAge(a.idade);
    parts.push(
      `${a.genero || ''}${age ? `, ${age}` : ''}, vibe ${a.vibe || ''}${a.textura_pele ? ', pele ' + a.textura_pele : ''}`,
    );
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
