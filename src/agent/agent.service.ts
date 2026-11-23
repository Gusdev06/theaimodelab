import { Injectable, Logger } from '@nestjs/common';
import { ContentSafetyEventKind, Resolution } from '@prisma/client';
import { ErrorCodes } from '../common/constants/error-codes';
import { ContentSafetyService } from '../content-safety/content-safety.service';
import { accountDeclarationMatch, isUncensoredModel, requiresConsentAlways } from '../content-safety/content-safety.interceptor';
import { assessText, withoutUnreadScripts } from '../content-safety/minor-guard';
import {
  TheaimodelabChatClient,
  ChatMessage,
  ChatPart,
} from '../prompt-enhancer/theaimodelab-chat.client';
import { PromptEnhancerService } from '../prompt-enhancer/prompt-enhancer.service';
import { GenerationsService } from '../generations/generations.service';
import { ModelsService } from '../models/models.service';
import { CreditsService } from '../credits/credits.service';
import { AgentChatDto, AgentImageDto } from './dto/agent-chat.dto';
import { AGENT_TOOLS, AGENT_SYSTEM_PROMPT } from './agent.tools';

const DEFAULT_MODEL = 'gemini-3.5-flash';
const MAX_STEPS = 8;

// Coerção segura de argumentos vindos do modelo (tipados como unknown).
const str = (v: unknown): string => String(v ?? '');
const optStr = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : String(v);
const optNum = (v: unknown): number | undefined => {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const optBool = (v: unknown): boolean | undefined =>
  v === undefined || v === null ? undefined : Boolean(v);

/** Resultado da trava do agente: a recusa (devolvida ao modelo) ou o atestado gravado para ligar à geração criada. */
type SafetyGate = { refused: Record<string, unknown> } | { refused: null; attestedEventId: string | null };

export interface ToolCallLog {
  name: string;
  args: Record<string, any>;
  result: any;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly chatClient: TheaimodelabChatClient,
    private readonly promptEnhancer: PromptEnhancerService,
    private readonly generations: GenerationsService,
    private readonly models: ModelsService,
    private readonly credits: CreditsService,
    private readonly contentSafety: ContentSafetyService,
  ) {}

  /**
   * Trava de segurança do agente, antes de qualquer geração: o prompt que o LLM escreve passa pela mesma
   * conferência de menor das rotas de geração. Foto do usuário em modelo sem censura segue com a declaração das imagens
   * que a conta já fez (atestado gravado, como no interceptor); sem ela, recusa (o agente não tem a tela do atestado).
   * O prompt negativo não é conferido ("child, teen" ali é o que EVITAR, como no interceptor).
   */
  private async refuseUnsafe(
    userId: string,
    tool: string,
    texts: (string | undefined)[],
    media: { hasUserImages: boolean; model?: string },
  ): Promise<SafetyGate> {
    for (const text of texts) {
      const verdict = assessText(text);
      if (!verdict.blocked) continue;
      if (verdict.reason === 'script') {
        // alfabeto que a trava não lê: recusado sem leitura e fora da trilha de abuso
        return { refused: { error: ErrorCodes.CONTENT_POLICY_LANGUAGE.message, code: ErrorCodes.CONTENT_POLICY_LANGUAGE.code } };
      }
      if (verdict.reason === 'size') {
        return { refused: { error: ErrorCodes.REQUEST_TOO_LARGE.message, code: ErrorCodes.REQUEST_TOO_LARGE.code } };
      }
      await this.contentSafety.record({
        userId,
        kind: ContentSafetyEventKind.MINOR_BLOCKED,
        route: `agent:${tool}`,
        match: verdict.match ?? null,
        excerpt: text ?? null,
      });
      return { refused: { error: ErrorCodes.CONTENT_POLICY_MINOR.message, code: ErrorCodes.CONTENT_POLICY_MINOR.code } };
    }
    if (requiresConsentAlways(media.model) || (media.hasUserImages && isUncensoredModel(media.model))) {
      // a conta já fez a declaração das imagens (na porta): vale como atestado, igual às rotas de geração (dono, 23/11)
      const declaration = await this.contentSafety.accountImageDeclaration(userId);
      if (declaration) {
        const attestedEventId = await this.contentSafety.recordOrThrow({
          userId,
          kind: ContentSafetyEventKind.CONSENT_ATTESTED,
          route: `agent:${tool}`,
          match: accountDeclarationMatch(declaration.version),
        });
        return { refused: null, attestedEventId };
      }
      await this.contentSafety.record({
        userId,
        kind: ContentSafetyEventKind.CONSENT_MISSING,
        route: `agent:${tool}`,
        match: media.model ?? null,
      });
      return {
        refused: {
          error: 'Foto de pessoa em modelo sem censura só pelo gerador, com a autorização de imagem. Use outro modelo aqui.',
          code: ErrorCodes.CONSENT_REQUIRED.code,
        },
      };
    }
    return { refused: null, attestedEventId: null };
  }

  /** Liga o atestado do agente à geração criada (o desvio para o modelo sem censura confere esse vínculo). */
  private async linkAttested(gate: SafetyGate, result: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (gate.refused === null && gate.attestedEventId && typeof result.id === 'string') {
      await this.contentSafety.linkGeneration(gate.attestedEventId, result.id);
    }
    return result;
  }

  async chat(userId: string, dto: AgentChatDto) {
    const model = dto.model || DEFAULT_MODEL;
    const images = dto.images ?? [];

    // Monta o histórico textual + a mensagem atual. As imagens NÃO entram no
    // stream de tokens: o agente as referencia por índice via ferramentas.
    const messages: ChatMessage[] = [];
    for (const h of dto.history ?? []) {
      messages.push({ role: h.role, parts: [{ text: h.text }] });
    }
    messages.push({ role: 'user', parts: [{ text: dto.message }] });

    const toolCalls: ToolCallLog[] = [];
    const generationIds: string[] = [];

    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await this.chatClient.chat({
        messages,
        system_instruction: AGENT_SYSTEM_PROMPT,
        model,
        temperature: 0.7,
        tools: AGENT_TOOLS,
      });

      const calls = res.functionCalls ?? [];

      // Sem chamadas de função → resposta final em texto.
      if (!calls.length) {
        return {
          reply: res.text,
          generationIds,
          toolCalls,
          steps: step,
          finishReason: res.finishReason,
        };
      }

      // Registra o turno do modelo (partes cruas: texto + functionCall).
      messages.push({
        role: 'model',
        parts: res.parts?.length
          ? res.parts
          : calls.map((c) => ({ functionCall: c })),
      });

      // Executa cada ferramenta e devolve os resultados como functionResponse.
      const responseParts: ChatPart[] = [];
      for (const call of calls) {
        const args = call.args ?? {};
        const result = await this.executeTool(userId, call.name, args, images);
        toolCalls.push({ name: call.name, args, result });
        if (typeof result.id === 'string' && result.status) {
          generationIds.push(result.id);
        }
        responseParts.push({
          functionResponse: { name: call.name, response: result },
        });
      }
      messages.push({ role: 'user', parts: responseParts });
    }

    // Estourou o limite de passos sem resposta final.
    this.logger.warn(
      `Agent atingiu MAX_STEPS (${MAX_STEPS}) sem resposta final (user=${userId})`,
    );
    return {
      reply:
        'Precisei de mais passos do que o permitido para concluir. ' +
        'As ações já disparadas foram registradas — tente refinar o pedido.',
      generationIds,
      toolCalls,
      steps: MAX_STEPS,
      finishReason: 'MAX_STEPS',
    };
  }

  /**
   * Executa uma ferramenta chamando os serviços reais. Qualquer erro vira um
   * objeto { error } — assim o modelo enxerga a falha e pode se corrigir, em
   * vez de derrubar a requisição inteira.
   */
  private async executeTool(
    userId: string,
    name: string,
    args: Record<string, unknown>,
    images: AgentImageDto[],
  ): Promise<Record<string, unknown>> {
    // alfabeto que a trava não lê sai do prompt em vez de recusar o pedido (mesma regra do interceptor, 23/11)
    if (typeof args.prompt === 'string') args.prompt = withoutUnreadScripts(args.prompt);
    try {
      switch (name) {
        case 'listar_modelos_imagem': {
          const list = await this.models.listImageModels();
          return {
            models: list.map((m) => ({
              slug: m.slug,
              label: m.label,
              description: m.description,
            })),
          };
        }

        case 'listar_modelos_video': {
          const list = await this.models.listVideoModels();
          return {
            models: list.map((m) => ({
              slug: m.slug,
              label: m.label,
              description: m.description,
            })),
          };
        }

        case 'consultar_saldo': {
          const b = await this.credits.getBalance(userId);
          return {
            totalCreditsAvailable: b.totalCreditsAvailable,
            planCreditsRemaining: b.planCreditsRemaining,
            bonusCreditsRemaining: b.bonusCreditsRemaining,
          };
        }

        case 'melhorar_prompt': {
          const gate = await this.refuseUnsafe(userId, name, [str(args.prompt)], { hasUserImages: false });
          if (gate.refused) return gate.refused;
          const r = await this.promptEnhancer.enhance(str(args.prompt));
          return { prompt: r.prompt, negativePrompt: r.negativePrompt };
        }

        case 'gerar_imagem': {
          const refImages = this.resolveImages(args.image_indexes, images);
          const gate = await this.refuseUnsafe(userId, name, [str(args.prompt)], {
            hasUserImages: refImages.length > 0,
            model: str(args.model),
          });
          if (gate.refused) return gate.refused;
          return this.linkAttested(gate, {
            ...(await this.generations.generateImage(userId, {
              prompt: str(args.prompt),
              model: str(args.model),
              resolution: str(args.resolution) as Resolution,
              aspect_ratio: optStr(args.aspect_ratio),
              ...(refImages.length ? { images: refImages } : {}),
            })),
          });
        }

        case 'gerar_video_texto': {
          const gate = await this.refuseUnsafe(userId, name, [str(args.prompt)], {
            hasUserImages: false,
            model: str(args.model),
          });
          if (gate.refused) return gate.refused;
          return this.linkAttested(gate, {
            ...(await this.generations.generateTextToVideo(userId, {
              prompt: str(args.prompt),
              model: str(args.model),
              resolution: str(args.resolution) as Resolution,
              aspect_ratio: optStr(args.aspect_ratio),
              duration_seconds: optNum(args.duration_seconds),
              generate_audio: optBool(args.generate_audio),
              negative_prompt: optStr(args.negative_prompt),
            })),
          });
        }

        case 'gerar_video_imagem': {
          const frame = this.pickImage(args.image_index, images);
          const gate = await this.refuseUnsafe(userId, name, [str(args.prompt)], {
            hasUserImages: true,
            model: optStr(args.model),
          });
          if (gate.refused) return gate.refused;
          return this.linkAttested(gate, {
            ...(await this.generations.generateImageToVideo(userId, {
              prompt: str(args.prompt),
              model: optStr(args.model),
              resolution: str(args.resolution) as Resolution,
              first_frame: frame.base64,
              first_frame_mime_type: frame.mime_type ?? 'image/png',
              aspect_ratio: optStr(args.aspect_ratio),
              duration_seconds: optNum(args.duration_seconds),
              generate_audio: optBool(args.generate_audio),
            })),
          });
        }

        case 'consultar_geracao': {
          const g = await this.generations.findById(
            userId,
            str(args.generation_id),
          );
          return {
            id: g.id,
            status: g.status,
            type: g.type,
            outputs: (g.outputs ?? []).map((o) => ({
              url: o.url,
              thumbnailUrl: o.thumbnailUrl,
              mimeType: o.mimeType,
            })),
          };
        }

        default:
          return { error: `Ferramenta desconhecida: ${name}` };
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Erro ao executar ferramenta';
      this.logger.error(`Tool "${name}" falhou: ${message}`);
      return { error: message };
    }
  }

  private pickImage(index: unknown, images: AgentImageDto[]): AgentImageDto {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= images.length) {
      throw new Error(
        `Índice de imagem inválido (${String(index)}). O usuário anexou ${images.length} imagem(ns).`,
      );
    }
    return images[i];
  }

  private resolveImages(
    indexes: unknown,
    images: AgentImageDto[],
  ): { base64: string; mime_type?: string }[] {
    if (!Array.isArray(indexes) || !indexes.length) return [];
    return indexes.map((idx: unknown) => {
      const img = this.pickImage(idx, images);
      return { base64: img.base64, mime_type: img.mime_type ?? 'image/png' };
    });
  }
}
