import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { ContentSafetyEventKind } from '@prisma/client';
import { Observable, tap } from 'rxjs';
import { BusinessException } from '../common/exceptions/business.exception';
import { ContentSafetyService } from './content-safety.service';
import { assessBody, collectTexts } from './minor-guard';

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ caminho */

/**
 * Caminho na forma em que o Express casa a rota: sem query string nem fragmento, em minúsculas (o roteamento do
 * Express não diferencia maiúsculas), barras repetidas viram uma e sem barra no fim. Sem isso,
 * "/API/v1/Generations/Face-Swap/" chegava ao handler da troca de rosto sem passar por regra nenhuma.
 */
export function normalizePath(raw: string | null | undefined): string {
  const path = String(raw ?? '')
    .split(/[?#]/)[0]
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
  return path || '/';
}

/* ------------------------------------------------------------------ modelos sem filtro */

/**
 * Modelos de imagem que mandam a foto do usuário direto a um provedor SEM filtro (Seedream na WaveSpeed com
 * `skipSafetyWrapper`, ver processImage/processImageWithFallback em generation.processor.ts).
 */
export const UNCENSORED_IMAGE_MODELS: ReadonlySet<string> = new Set([
  // Unlocked: roda direto no Seedream sem o wrapper que força roupa
  'sem-censura',
  // rótulo do fallback sem censura (modelUsed da geração); o DTO não aceita hoje, fica para nunca virar brecha
  'sem-censura-fallback',
  // ferramenta de despir: Seedream com prompt de despir sobre a foto enviada
  'deepdeep',
]);

/** Modelos de vídeo sem filtro (slugs da tabela ai_models). Usados onde o modelo vem no corpo (agente). */
export const UNCENSORED_VIDEO_MODELS: ReadonlySet<string> = new Set([
  // WaveSpeed LTX 2.3 Spicy
  'wavespeed-ltx-spicy',
  // WaveSpeed Seedance 2.0 Fast Spicy
  'wavespeed-seedance-spicy',
  // ComfyDeploy WAN (NSFW/legado)
  'comfydeploy-wan',
  // WaveSpeed MiniMax H3: tratado como sem censura na operação (o suporte o lista assim)
  'wavespeed-minimax-h3',
]);

/** Despir: o atestado é obrigatório com ou sem foto (não existe despir sem a foto de alguém). */
const CONSENT_ALWAYS_MODELS: ReadonlySet<string> = new Set(['deepdeep']);

/** Slug que se apresenta como sem filtro: modelo novo com esse nome já entra na regra antes de entrar na lista. */
const UNCENSORED_SLUG = /sem-censura|unlocked|uncensored|spicy|nsfw/;

function modelSlug(model: unknown): string {
  return typeof model === 'string' ? model.trim().toLowerCase() : '';
}

/** O modelo pedido manda a mídia a um provedor sem filtro? */
export function isUncensoredModel(model: unknown): boolean {
  const slug = modelSlug(model);
  if (!slug) return false;
  return UNCENSORED_IMAGE_MODELS.has(slug) || UNCENSORED_VIDEO_MODELS.has(slug) || UNCENSORED_SLUG.test(slug);
}

/** Modelo que exige o atestado mesmo sem foto no pedido (despir). */
export function requiresConsentAlways(model: unknown): boolean {
  return CONSENT_ALWAYS_MODELS.has(modelSlug(model));
}

/* ------------------------------------------------------------------ regras de atestado */

/**
 * Quando o atestado de imagem ("a foto é de uma pessoa gerada por IA ou de um adulto que autorizou") é exigido:
 * - always: a ferramenta põe a foto de uma pessoa no resultado; sempre exige
 * - with-media: a rota manda a foto/vídeo do pedido direto a um provedor sem filtro; exige quando há mídia
 * - uncensored-model: exige quando o modelo é sem filtro e há foto (despir: sempre); com modelo comum, como optional
 * - optional: provedor com filtro; nunca exige, mas o atestado enviado com foto é gravado e ligado à geração
 */
export type ConsentRequirement = 'always' | 'with-media' | 'uncensored-model' | 'optional';

export interface ConsentRule {
  require: ConsentRequirement;
  /** campos do corpo que trazem foto/vídeo do usuário (string base64, lista ou objeto { base64 }) */
  media: readonly string[];
}

/**
 * Rotas de POST /api/v1/generations/<rota> que recebem foto ou vídeo do usuário. Rota fora daqui não exige nem
 * guarda atestado. O DTO de cada uma aceita `consent_confirmed`, para o site repetir o pedido com o atestado
 * quando recebe 400 CONSENT_REQUIRED.
 *
 * Por que os "optional" guardam o atestado: quando o provedor com filtro bloqueia um pedido com foto, o processor
 * cai no modelo sem censura (fallbackToSeedream) usando a mesma foto. Esse fallback só pode usar a foto se a
 * geração nasceu de um pedido atestado (ContentSafetyService.hasConsentForGeneration), e é este registro ligado à
 * geração que prova isso.
 */
export const CONSENT_RULES: Readonly<Record<string, ConsentRule>> = {
  // troca de rosto: o rosto enviado é sempre de alguém (e no modo Unlocked vai direto ao Seedream sem censura)
  'face-swap': { require: 'always', media: ['source_image', 'target_image'] },
  // provador virtual: a "influencer" pode ser a foto de uma pessoa real; se o Gemini bloqueia, cai no Seedream sem censura com a foto
  'virtual-try-on': { require: 'always', media: ['influencer_image', 'clothing_image'] },
  // motion control (Kling 2.6): põe a pessoa da foto enviada no lugar de quem está no vídeo (troca de identidade em vídeo)
  'motion-control': { require: 'always', media: ['image', 'video'] },
  // avatar falante (OmniHuman 1.5): põe fala e boca na pessoa da foto enviada (identidade em vídeo)
  'talking-avatar': { require: 'always', media: ['image'] },
  // imagem: deepdeep (despir) sempre; "sem-censura" (Unlocked) com foto vai direto ao Seedream sem filtro
  'generate-image': { require: 'uncensored-model', media: ['images'] },
  // mesma regra da rota acima (mesmo DTO, mesmo desvio para o Seedream no processImageWithFallback)
  'generate-image-auto': { require: 'uncensored-model', media: ['images'] },
  // WaveSpeed LTX 2.3 Spicy: image-to-video sem filtro, o primeiro frame é a foto do usuário
  'image-to-video-wavespeed': { require: 'with-media', media: ['first_frame'] },
  // WaveSpeed Seedance 2.0 Fast Spicy: image-to-video sem filtro a partir da foto enviada
  'image-to-video-seedance-spicy': { require: 'with-media', media: ['first_frame'] },
  // ComfyDeploy WAN (NSFW/legado): image-to-video sem filtro a partir da foto enviada
  'image-to-video-comfydeploy': { require: 'with-media', media: ['first_frame'] },
  // WaveSpeed MiniMax H3: o provider o chama de "geral", mas a operação o trata como sem censura; na dúvida, exige
  'minimax-h3-image-to-video': { require: 'with-media', media: ['first_frame', 'last_frame'] },
  // MiniMax H3 com referências: fotos e vídeos de pessoa como referência no mesmo provedor
  'minimax-h3-reference-to-video': { require: 'with-media', media: ['reference_images', 'reference_videos'] },
  // upscale: Gemini com filtro; bloqueado, o fallback reenvia a foto ao Seedream sem censura
  upscale: { require: 'optional', media: ['image'] },
  // Nano Banana (kie): com filtro; bloqueado, cai no Seedream sem censura com as fotos (processNanoBanana)
  'generate-image-nano-banana': { require: 'optional', media: ['images'] },
  // Veo (Vertex) image-to-video: com filtro; fica pronto para o fallback de vídeo sem censura
  'image-to-video': { require: 'optional', media: ['first_frame', 'last_frame'] },
  // Veo (Vertex) com referências: com filtro
  'video-with-references': { require: 'optional', media: ['reference_images'] },
  // Veo (kie) image-to-video: com filtro
  'image-to-video-kie': { require: 'optional', media: ['first_frame', 'last_frame'] },
  // Veo (kie) com referências: com filtro
  'reference-to-video-kie': { require: 'optional', media: ['reference_images'] },
  // Grok Imagine (kie, modo normal): com filtro
  'image-to-video-grok': { require: 'optional', media: ['first_frame', 'last_frame'] },
  // Gemini Omni (kie): com filtro, aceita fotos e um vídeo de referência
  'omni-video': { require: 'optional', media: ['images', 'video'] },
  // Seedance 2.x (kie): com filtro, fotos/vídeo de referência e frames
  'seedance-video': { require: 'optional', media: ['reference_images', 'reference_video', 'first_frame', 'last_frame'] },
  // Kling V3 Turbo (kie): com filtro
  'image-to-video-kling': { require: 'optional', media: ['first_frame'] },
};

/** Regra da rota (último trecho depois de /generations/), sem cair em propriedade herdada do Object. */
export function consentRuleFor(path: string): ConsentRule | undefined {
  const match = /\/generations\/([^/]+)$/.exec(normalizePath(path));
  if (!match) return undefined;
  return Object.prototype.hasOwnProperty.call(CONSENT_RULES, match[1]) ? CONSENT_RULES[match[1]] : undefined;
}

/** Algum dos campos traz mídia? Texto não vazio, lista não vazia ou objeto ({ base64 }). */
export function hasMedia(body: unknown, fields: readonly string[]): boolean {
  if (!isRecord(body)) return false;
  return fields.some((field) => {
    const value = body[field];
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return isRecord(value);
  });
}

/**
 * - required: sem `consent_confirmed: true`, recusa (400 CONSENT_REQUIRED)
 * - optional: segue sem atestado; com ele, o atestado é gravado e ligado à geração
 * - none: rota sem foto de pessoa; nada a atestar
 */
export type ConsentDecision = 'required' | 'optional' | 'none';

export function consentDecision(path: string, body: unknown): ConsentDecision {
  const rule = consentRuleFor(path);
  if (!rule) return 'none';
  const withMedia = hasMedia(body, rule.media);
  switch (rule.require) {
    case 'always':
      return 'required';
    case 'with-media':
      return withMedia ? 'required' : 'none';
    case 'uncensored-model': {
      const model = isRecord(body) ? body.model : undefined;
      if (requiresConsentAlways(model)) return 'required';
      if (!withMedia) return 'none';
      return isUncensoredModel(model) ? 'required' : 'optional';
    }
    case 'optional':
      return withMedia ? 'optional' : 'none';
  }
}

/** A rota exige o atestado para este corpo? */
export function requiresConsent(path: string, body: unknown): boolean {
  return consentDecision(path, body) === 'required';
}

/** Atestado válido: só o booleano true ("true" em texto não vale). */
export function hasConsent(body: unknown): boolean {
  return isRecord(body) && body.consent_confirmed === true;
}

/* ------------------------------------------------------------------ evidência */

/** Trecho dos textos livres do pedido para a revisão de abuso (até 300 caracteres, nunca o corpo inteiro). */
export function safetyExcerpt(body: unknown): string | null {
  try {
    const text = collectTexts(body).join(' ').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 300) : null;
  } catch {
    return null;
  }
}

/** Id da geração criada pelo pedido: as rotas de geração respondem { id } (avatares: { generationId }). */
export function generationIdOf(response: unknown): string | null {
  if (!isRecord(response)) return null;
  for (const key of ['generationId', 'id']) {
    const value = response[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

interface SafetyRequest {
  method?: string;
  path?: string;
  url?: string;
  originalUrl?: string;
  /** rota declarada que o Express casou (ex.: /api/v1/generations/face-swap), quando existe */
  route?: { path?: unknown };
  body?: unknown;
  user?: { sub?: string };
}

const INSPECTED_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Camada de segurança de conteúdo da plataforma, aplicada nos controllers que recebem pedido de geração
 * (gerações, avatares falantes, turbinar prompt, agentes). Roda ANTES de qualquer provedor de IA e de qualquer
 * cobrança (interceptor roda antes dos pipes e do handler):
 *  1. corpo grande demais para ser lido inteiro → recusa (413 REQUEST_TOO_LARGE), nunca libera sem ler
 *  2. qualquer texto livre do pedido que faça referência a menor de idade → recusa (422 CONTENT_POLICY_MINOR)
 *  3. ferramenta de foto de pessoa sem o atestado de consentimento → recusa (400 CONSENT_REQUIRED)
 * A recusa por menor, a falta de atestado e cada atestado aceito ficam na trilha de auditoria
 * (content_safety_events); o atestado é gravado antes do handler (sem registro, sem geração) e depois ligado à
 * geração criada. Um interceptor com a tabela de regras no lugar de 23 alterações no generations.service: rota nova
 * entra pela tabela, sem depender de lembrar de decorar o handler.
 */
@Injectable()
export class ContentSafetyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ContentSafetyInterceptor.name);

  constructor(private readonly safety: ContentSafetyService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<SafetyRequest>();
    const method = String(req.method ?? '').toUpperCase();
    if (!INSPECTED_METHODS.has(method)) return next.handle();

    // a rota que o Express casou é a fonte mais fiel; sem ela (teste unitário), a URL normalizada
    const declared = typeof req.route?.path === 'string' ? req.route.path : undefined;
    const path = normalizePath(declared ?? req.originalUrl ?? req.url ?? req.path);
    const route = `${method} ${path}`;
    const userId = req.user?.sub ?? null;
    const body = req.body;

    const assessment = assessBody(body);
    if (assessment.blocked) {
      if (assessment.reason === 'size') {
        // tamanho não é indício de menor: não entra na trilha de abuso, só não é liberado sem leitura
        this.logger.warn(`content-safety: pedido grande demais para conferir (${route}, usuário ${userId ?? '-'})`);
        throw new BusinessException('REQUEST_TOO_LARGE');
      }
      if (assessment.reason === 'script') {
        // alfabeto sem lista na trava: recusado sem leitura, também fora da trilha de abuso
        this.logger.warn(`content-safety: alfabeto que a trava não lê (${route}, usuário ${userId ?? '-'})`);
        throw new BusinessException('CONTENT_POLICY_LANGUAGE');
      }
      await this.safety.record({
        userId,
        kind: ContentSafetyEventKind.MINOR_BLOCKED,
        route,
        match: assessment.match ?? null,
        excerpt: safetyExcerpt(body),
      });
      throw new BusinessException('CONTENT_POLICY_MINOR');
    }

    const decision = consentDecision(path, body);
    if (decision === 'none') return next.handle();
    if (!hasConsent(body)) {
      if (decision === 'optional') return next.handle();
      await this.safety.record({ userId, kind: ContentSafetyEventKind.CONSENT_MISSING, route });
      throw new BusinessException('CONSENT_REQUIRED');
    }

    // fail closed: sem o atestado gravado, o pedido não segue (o service responde 503)
    const eventId = await this.safety.recordOrThrow({ userId, kind: ContentSafetyEventKind.CONSENT_ATTESTED, route });
    return next.handle().pipe(tap((response) => this.linkInBackground(eventId, response)));
  }

  /** Liga o atestado à geração criada, sem segurar a resposta e sem derrubá-la se a ligação falhar. */
  private linkInBackground(eventId: string, response: unknown): void {
    const generationId = generationIdOf(response);
    if (!generationId) return;
    Promise.resolve()
      .then(() => this.safety.linkGeneration(eventId, generationId))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`content-safety: atestado ${eventId} sem ligação com a geração ${generationId}: ${message}`);
      });
  }
}
