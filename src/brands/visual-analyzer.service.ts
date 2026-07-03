import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import {
  ChatPart,
  TheaimodelabChatClient,
} from '../prompt-enhancer/theaimodelab-chat.client';

const SYSTEM_PROMPT = `Você é um Visual Brand Analyzer. Sua função é receber UMA OU MAIS imagens de referência (logo, fotos de produto, anúncios de exemplo, materiais de identidade visual) e devolver um JSON único que sintetize a identidade visual da marca + observações por imagem.

## ESTRUTURA OBRIGATÓRIA DO JSON DE SAÍDA

{
  "brand_identity": {
    "palette": ["array de cores predominantes em hex (#RRGGBB), até 6 cores"],
    "visual_style": "string curta descrevendo o estilo (ex: minimalista premium, retro vibrante, brutalismo digital, lifestyle aspiracional)",
    "tone": "string sobre o tom emocional/personalidade (ex: descontraído, sério, aspiracional, divertido, sofisticado)",
    "composition_patterns": ["array de padrões de composição observados (ex: produto centralizado, full bleed, grid simétrico)"],
    "subject_focus": "string (ex: produto hero, lifestyle com pessoas, abstrato, mascotes, screenshots de UI)",
    "typography_hints": "string sobre tipografia visível (sans-serif moderna, serifa clássica, display, manuscrita, ou 'sem texto visível')",
    "mood_keywords": ["array de 3-6 palavras-chave de mood (ex: clean, ousado, calmo, tech, orgânico, urbano)"]
  },
  "assets": [
    {
      "url": "string — a URL EXATA da imagem analisada (preservar como recebida)",
      "observations": "string de 1-3 frases descrevendo o que esta imagem específica contribui pra identidade",
      "key_elements": ["array de elementos chave dessa imagem (ex: logo wordmark, modelo segurando produto, paleta neon)"]
    }
  ]
}

## REGRAS CRÍTICAS

1. RETORNE APENAS O JSON. Sem markdown, sem \`\`\`json, sem texto antes ou depois. Apenas o objeto JSON puro começando com { e terminando com }.
2. A ordem do array "assets" DEVE corresponder à ordem das imagens recebidas no input.
3. As URLs em "assets[].url" devem ser PRESERVADAS exatamente como foram enviadas no prompt do usuário.
4. Seja DESCRITIVO mas CONCISO — o output será consumido por outros agentes (Copywriter e Visual Prompt Engineer) pra gerar criativos coerentes com a marca.
5. Se houver inconsistência entre as imagens (estilos muito diferentes), sintetize o que há em comum e mencione o conflito em "visual_style".
6. Se receber UMA imagem só, ainda preencha TODOS os campos com o que dá pra observar dela.
7. SE QUALQUER IMAGEM contiver conteúdo inapropriado, retorne apenas: {"error": "conteudo_inapropriado"}
8. NUNCA invente cores ou estilos que não estão nas imagens. Use apenas o que você observa.

Analise as imagens enviadas e retorne APENAS o JSON.`;

type MediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export interface BrandIdentity {
  palette: string[];
  visual_style: string;
  tone: string;
  composition_patterns: string[];
  subject_focus: string;
  typography_hints: string;
  mood_keywords: string[];
}

export interface AssetAnalysis {
  url: string;
  observations: string;
  key_elements: string[];
}

export interface VisualAnalysisResult {
  brand_identity: BrandIdentity;
  assets: AssetAnalysis[];
}

@Injectable()
export class VisualAnalyzerService {
  private readonly logger = new Logger(VisualAnalyzerService.name);

  constructor(private readonly chatClient: TheaimodelabChatClient) {}

  async analyze(imageUrls: string[]): Promise<VisualAnalysisResult> {
    if (imageUrls.length === 0) {
      throw new BadRequestException({
        code: 'NO_REFERENCES',
        message: 'Pelo menos uma imagem de referência é necessária.',
      });
    }
    if (imageUrls.length > 10) {
      throw new BadRequestException({
        code: 'TOO_MANY_REFERENCES',
        message: 'Máximo de 10 imagens por análise.',
      });
    }

    const imageBlocks: ChatPart[] = [];
    for (const url of imageUrls) {
      imageBlocks.push(await this.fetchImageBlock(url));
    }

    const userText = `URLs das imagens, na ordem em que aparecem (preserve-as em assets[].url):\n${imageUrls
      .map((u, i) => `${i + 1}. ${u}`)
      .join('\n')}\n\nAnalise e retorne APENAS o JSON com brand_identity e assets[].`;

    const raw = await this.callModel(imageBlocks, userText);
    let json: any;
    try {
      json = this.extractJson(raw);
    } catch (err: any) {
      this.logger.warn(`Retry parse — primeiro JSON inválido: ${err.message}`);
      const retryRaw = await this.callModel(
        imageBlocks,
        `${userText}\n\nIMPORTANTE: o JSON anterior falhou a validação (${err.message}). Retorne APENAS o JSON corrigido.`,
      );
      json = this.extractJson(retryRaw);
    }

    if (json?.error === 'conteudo_inapropriado') {
      throw new BadRequestException({
        code: 'INAPPROPRIATE_CONTENT',
        message:
          'Conteúdo inapropriado detectado em uma das imagens de referência.',
      });
    }

    this.validateShape(json);
    return json as VisualAnalysisResult;
  }

  private async callModel(
    images: ChatPart[],
    userText: string,
  ): Promise<string> {
    const res = await this.chatClient.chat({
      system_instruction: SYSTEM_PROMPT,
      max_output_tokens: 4096,
      temperature: 0.3,
      messages: [
        {
          role: 'user',
          parts: [...images, { text: userText }],
        },
      ],
    });
    return res.text || '';
  }

  private async fetchImageBlock(url: string): Promise<ChatPart> {
    if (!/^https?:\/\//i.test(url)) {
      throw new BadRequestException({
        code: 'INVALID_IMAGE_URL',
        message: `URL inválida: ${url}. Use HTTPS.`,
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new BadRequestException({
          code: 'IMAGE_FETCH_FAILED',
          message: `Falha ao baixar imagem (HTTP ${res.status}): ${url}`,
        });
      }
      const contentType = (res.headers.get('content-type') || '')
        .toLowerCase()
        .split(';')[0]
        .trim();
      const allowed: MediaType[] = [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
      ];
      if (!allowed.includes(contentType as MediaType)) {
        throw new BadRequestException({
          code: 'INVALID_IMAGE_FORMAT',
          message: `Tipo não suportado (${contentType || 'desconhecido'}): ${url}`,
        });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 5 * 1024 * 1024) {
        throw new BadRequestException({
          code: 'FILE_TOO_LARGE',
          message: `Imagem excede 5MB: ${url}`,
        });
      }
      return {
        inline_data: {
          base64: buf.toString('base64'),
          mime_type: contentType,
        },
      };
    } finally {
      clearTimeout(timeout);
    }
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

  private validateShape(json: any): void {
    if (!json?.brand_identity || typeof json.brand_identity !== 'object') {
      throw new InternalServerErrorException({
        code: 'VISUAL_ANALYZER_INVALID_SHAPE',
        message: 'brand_identity ausente no output do agente.',
      });
    }
    if (!Array.isArray(json.assets)) {
      throw new InternalServerErrorException({
        code: 'VISUAL_ANALYZER_INVALID_SHAPE',
        message: 'assets[] ausente no output do agente.',
      });
    }
  }
}
