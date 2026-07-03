import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

// ─── HeyGen v3 types ────────────────────────────────────────────────────────

export type HeyGenAvatarStatus =
  | 'processing'
  | 'pending_consent'
  | 'failed'
  | 'completed';

export type HeyGenConsentStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | null;

export type HeyGenAvatarEngine = 'avatar_iv' | 'avatar_v';

export type HeyGenVideoStatus =
  | 'waiting'
  | 'processing'
  | 'completed'
  | 'failed';

export interface HeyGenCreateDigitalTwinResult {
  lookId: string;
  groupId: string;
}

export interface HeyGenAvatarGroupSnapshot {
  groupId: string;
  status: HeyGenAvatarStatus | null;
  consentStatus: HeyGenConsentStatus;
  errorCode: string | null;
  errorMessage: string | null;
  /** Group-level fallbacks — useful when individual looks don't carry these. */
  groupDefaultVoiceId: string | null;
  groupPreviewImageUrl: string | null;
  looks: Array<{
    lookId: string;
    name: string;
    previewImageUrl: string | null;
    previewVideoUrl: string | null;
    defaultVoiceId: string | null;
    supportedEngines: string[];
    status: HeyGenAvatarStatus | null;
  }>;
}

export interface HeyGenCreateVideoInput {
  avatarId: string;          // look id (avatar_item.id)
  script?: string;
  voiceId?: string;
  audioUrl?: string;
  engine?: HeyGenAvatarEngine;
  resolution?: '720p' | '1080p' | '4k';
  aspectRatio?: '16:9' | '9:16';
  background?: { type: 'color'; value: string } | { type: 'image'; url: string };
  callbackUrl?: string;
  callbackId?: string;
  title?: string;
}

export interface HeyGenCreateVideoResult {
  videoId: string;
  status: string;
}

@Injectable()
export class HeyGenProvider {
  private readonly logger = new Logger(HeyGenProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly webhookSecret: string;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = (
      this.configService.get<string>('HEYGEN_BASE_URL', 'https://api.heygen.com') ?? ''
    ).replace(/\/$/, '');
    this.apiKey = (this.configService.get<string>('HEYGEN_API_KEY', '') ?? '').trim();
    this.webhookSecret = (
      this.configService.get<string>('HEYGEN_WEBHOOK_SECRET', '') ?? ''
    ).trim();

    if (!this.apiKey) {
      this.logger.warn(
        'HEYGEN_API_KEY is not set. Avatar creation will fail with 401 from HeyGen.',
      );
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * POST /v3/avatars (type: digital_twin) — kicks off avatar training.
   * Returns the look ID (used as avatar_id when creating videos) and
   * the group ID (used to initiate consent and to query status).
   *
   * Videos pretty much always exceed HeyGen's 32MB URL-input cap, so we
   * always go through the /v1/asset upload path here. Costs an extra hop
   * but avoids the 'invalid_parameter: too large' rejection.
   */
  async createDigitalTwin(input: {
    name: string;
    fileUrl: string;
  }): Promise<HeyGenCreateDigitalTwinResult> {
    this.ensureConfigured();

    this.logger.log(`[HEYGEN] createDigitalTwin name="${input.name}" fileUrl=${input.fileUrl} (uploading via /v1/asset)`);

    // Upload to HeyGen's asset bucket and use the returned asset_id —
    // /v3/avatars URL inputs are capped at 32MB.
    const assetId = await this.uploadAsset(input.fileUrl, 'video/mp4');

    const body = {
      type: 'digital_twin' as const,
      name: input.name,
      // HeyGen's file discriminator accepts: 'url' | 'asset_id' | 'base64'
      file: { type: 'asset_id' as const, asset_id: assetId },
    };

    const response = await this.fetchJson<{
      data: {
        avatar_item: {
          id: string;
          group_id: string;
        };
        avatar_group: {
          id: string;
          consent_status: HeyGenConsentStatus;
        };
      };
    }>(`${this.baseUrl}/v3/avatars`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    // FULL response from HeyGen — useful for debugging the consent issue
    this.logger.log(
      `[HEYGEN_RAW_RESPONSE] createDigitalTwin → ${JSON.stringify(response).slice(0, 800)}`,
    );

    const lookId = response.data?.avatar_item?.id;
    const groupId = response.data?.avatar_item?.group_id ?? response.data?.avatar_group?.id;

    if (!lookId || !groupId) {
      this.logger.error(
        `HeyGen createDigitalTwin missing ids in response: ${JSON.stringify(response).slice(0, 400)}`,
      );
      throw new Error('Não foi possível iniciar a criação do avatar. Tente novamente em alguns instantes.');
    }

    this.logger.log(
      `[HEYGEN] ✅ digital_twin created — group_id=${groupId} look_id=${lookId} consent_status=${response.data?.avatar_group?.consent_status ?? 'null'}`,
    );

    return { lookId, groupId };
  }

  /**
   * POST /v3/avatars (type: photo) — kicks off photo avatar creation.
   * Photo avatars do not require consent and become READY quickly (seconds to minutes).
   */
  async createPhotoAvatar(input: {
    name: string;
    fileUrl: string;
  }): Promise<HeyGenCreateDigitalTwinResult> {
    this.ensureConfigured();

    const body = {
      type: 'photo' as const,
      name: input.name,
      file: { type: 'url' as const, url: input.fileUrl },
    };

    this.logger.log(`[HEYGEN] createPhotoAvatar name="${input.name}" fileUrl=${input.fileUrl}`);

    const response = await this.fetchJson<{
      data: {
        avatar_item: { id: string; group_id: string };
        avatar_group: { id: string; consent_status: HeyGenConsentStatus };
      };
    }>(`${this.baseUrl}/v3/avatars`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const lookId = response.data?.avatar_item?.id;
    const groupId = response.data?.avatar_item?.group_id ?? response.data?.avatar_group?.id;

    if (!lookId || !groupId) {
      this.logger.error(
        `HeyGen createPhotoAvatar missing ids in response: ${JSON.stringify(response).slice(0, 400)}`,
      );
      throw new Error('Não foi possível iniciar a criação do avatar. Tente novamente em alguns instantes.');
    }

    return { lookId, groupId };
  }

  /**
   * GET /v3/avatars/{group_id} — used as a status snapshot. Drives both
   * polling fallback and webhook reconciliation.
   */
  async getAvatarGroup(groupId: string): Promise<HeyGenAvatarGroupSnapshot> {
    this.ensureConfigured();

    // Defensive parsing: HeyGen docs are inconsistent. Some endpoints return
    // data.avatar_group + data.looks (nested); others return data directly
    // as the group with no looks attached. We accept both and fall back to
    // /v3/avatar-looks?group_id=... for looks if needed.
    const raw = await this.fetchJson<{ data: any }>(
      `${this.baseUrl}/v3/avatars/${encodeURIComponent(groupId)}`,
      { method: 'GET' },
    );

    this.logger.log(
      `[HEYGEN_RAW_RESPONSE] getAvatarGroup ${groupId} → ${JSON.stringify(raw).slice(0, 1500)}`,
    );

    const data = raw?.data;
    if (!data) {
      throw new Error(`HeyGen não retornou dados do avatar ${groupId}.`);
    }

    // Shape A (nested): { data: { avatar_group: {...}, looks: [...] } }
    // Shape B (flat):   { data: { id, name, status, consent_status, ... } }
    const group = (data.avatar_group ?? data) as {
      id?: string;
      consent_status?: HeyGenConsentStatus;
      status?: HeyGenAvatarStatus | null;
      error?: { code: string; message: string } | null;
      default_voice_id?: string | null;
      preview_image_url?: string | null;
    };

    const looksRaw: any[] = data.looks ?? data.avatar_looks ?? [];
    let looks: HeyGenAvatarGroupSnapshot['looks'] = looksRaw.map((look: any) => ({
      lookId: look.id ?? look.lookId,
      name: look.name,
      previewImageUrl: look.preview_image_url ?? null,
      previewVideoUrl: look.preview_video_url ?? null,
      defaultVoiceId: look.default_voice_id ?? null,
      supportedEngines: look.supported_api_engines ?? [],
      status: look.status ?? null,
    }));

    // Fallback: HeyGen's GET /v3/avatars/{group_id} returns the flat shape
    // without the looks array — only `looks_count`. When the group is ready
    // we MUST fetch the looks separately to get the real look_id (the one
    // POST /v3/videos accepts as avatar_id). The id we saved at creation time
    // can be a placeholder until rendering completes.
    const looksCount: number = typeof data.looks_count === 'number' ? data.looks_count : 0;
    const shouldFetchLooks =
      looks.length === 0 &&
      (group.status === 'completed' || looksCount > 0);
    if (shouldFetchLooks) {
      try {
        looks = await this.listAvatarLooks(groupId);
      } catch (err) {
        this.logger.warn(
          `[HEYGEN] listAvatarLooks fallback failed for ${groupId}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }

    return {
      groupId: group.id ?? groupId,
      status: group.status ?? null,
      consentStatus: group.consent_status ?? null,
      errorCode: group.error?.code ?? null,
      errorMessage: group.error?.message ?? null,
      groupDefaultVoiceId: group.default_voice_id ?? null,
      groupPreviewImageUrl: group.preview_image_url ?? null,
      looks,
    };
  }

  /**
   * GET /v3/avatars/looks?group_id={groupId}
   * Lists all looks for a given avatar group. Paginated via `token`/`limit`.
   * Used as a fallback inside getAvatarGroup when the main endpoint returns
   * the flat shape without an embedded looks array.
   */
  async listAvatarLooks(groupId: string): Promise<HeyGenAvatarGroupSnapshot['looks']> {
    this.ensureConfigured();

    const looks: HeyGenAvatarGroupSnapshot['looks'] = [];
    let nextToken: string | undefined;
    // Safety cap: typical groups have 1–4 looks; never more than a few pages
    for (let page = 0; page < 5; page++) {
      const url = new URL(`${this.baseUrl}/v3/avatars/looks`);
      url.searchParams.set('group_id', groupId);
      url.searchParams.set('limit', '50');
      if (nextToken) url.searchParams.set('token', nextToken);

      const raw = await this.fetchJson<{
        data?: any;
        has_more?: boolean;
        next_token?: string | null;
      }>(url.toString(), { method: 'GET' });

      this.logger.log(
        `[HEYGEN_RAW_RESPONSE] listAvatarLooks ${groupId} page=${page} → ${JSON.stringify(raw).slice(0, 800)}`,
      );

      // The endpoint can return either `data: [...]` or `data: { looks: [...], has_more, next_token }`
      const arr: any[] = Array.isArray(raw?.data)
        ? raw.data
        : Array.isArray(raw?.data?.looks)
          ? raw.data.looks
          : [];
      for (const look of arr) {
        looks.push({
          lookId: look.id ?? look.lookId,
          name: look.name,
          previewImageUrl: look.preview_image_url ?? null,
          previewVideoUrl: look.preview_video_url ?? null,
          defaultVoiceId: look.default_voice_id ?? null,
          supportedEngines: look.supported_api_engines ?? [],
          status: look.status ?? null,
        });
      }

      const hasMore = raw?.has_more ?? raw?.data?.has_more ?? false;
      nextToken = raw?.next_token ?? raw?.data?.next_token ?? undefined;
      if (!hasMore || !nextToken) break;
    }
    return looks;
  }

  /**
   * DELETE /v3/avatars/{group_id} — removes the avatar from HeyGen.
   * Best-effort: errors are logged but not re-thrown so our delete flow can proceed.
   */
  async deleteAvatarGroup(groupId: string): Promise<void> {
    this.ensureConfigured();

    this.logger.log(`[HEYGEN] deleteAvatarGroup groupId=${groupId}`);

    try {
      const response = await this.fetchWithTimeout(
        `${this.baseUrl}/v3/avatars/${encodeURIComponent(groupId)}`,
        { method: 'DELETE', headers: this.headers() },
        30_000,
      );
      if (!response.ok && response.status !== 404) {
        const body = await response.text();
        this.logger.warn(
          `HeyGen deleteAvatarGroup failed status=${response.status} groupId=${groupId} body=${body.slice(0, 300)}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `HeyGen deleteAvatarGroup threw for groupId=${groupId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  /**
   * POST /v3/videos — generates a video using a trained avatar (look).
   * `engine` defaults to avatar_iv when omitted.
   */
  async createAvatarVideo(input: HeyGenCreateVideoInput): Promise<HeyGenCreateVideoResult> {
    this.ensureConfigured();

    if (!input.script && !input.audioUrl) {
      throw new Error('createAvatarVideo: forneça script ou audioUrl.');
    }
    if (input.script && input.audioUrl) {
      throw new Error('createAvatarVideo: script e audioUrl são mutuamente exclusivos.');
    }

    const body: Record<string, unknown> = {
      type: 'avatar',
      avatar_id: input.avatarId,
    };
    if (input.title) body.title = input.title;
    if (input.engine) body.engine = { type: input.engine };
    if (input.resolution) body.resolution = input.resolution;
    if (input.aspectRatio) body.aspect_ratio = input.aspectRatio;
    if (input.callbackUrl) body.callback_url = input.callbackUrl;
    if (input.callbackId) body.callback_id = input.callbackId;
    if (input.script) {
      body.script = input.script;
      if (input.voiceId) body.voice_id = input.voiceId;
    }
    if (input.audioUrl) {
      body.audio_url = input.audioUrl;
    }
    if (input.background) {
      body.background =
        input.background.type === 'color'
          ? { type: 'color', value: input.background.value }
          : { type: 'image', url: input.background.url };
    }

    this.logger.log(
      `[HEYGEN] createAvatarVideo avatar=${input.avatarId} engine=${input.engine ?? 'avatar_iv'} resolution=${input.resolution ?? '1080p'}`,
    );

    const response = await this.fetchJson<{
      data: { video_id: string; status: string };
    }>(`${this.baseUrl}/v3/videos`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const videoId = response.data?.video_id;
    if (!videoId) {
      this.logger.error(
        `HeyGen createAvatarVideo missing video_id: ${JSON.stringify(response).slice(0, 400)}`,
      );
      throw new Error('Não foi possível iniciar a geração do vídeo. Tente novamente em alguns instantes.');
    }
    return { videoId, status: response.data.status };
  }

  /**
   * GET /v3/videos/{video_id} — used as polling fallback if the per-request
   * webhook is missed.
   */
  async getVideoStatus(videoId: string): Promise<{
    videoId: string;
    status: HeyGenVideoStatus;
    videoUrl: string | null;
    thumbnailUrl: string | null;
    durationSeconds: number | null;
    errorMessage: string | null;
  }> {
    this.ensureConfigured();

    const response = await this.fetchJson<{
      data: {
        id: string;
        status: HeyGenVideoStatus;
        video_url: string | null;
        thumbnail_url: string | null;
        duration: number | null;
        error?: { message?: string } | null;
      };
    }>(`${this.baseUrl}/v3/videos/${encodeURIComponent(videoId)}`, { method: 'GET' });

    const data = response.data;
    return {
      videoId: data.id,
      status: data.status,
      videoUrl: data.video_url,
      thumbnailUrl: data.thumbnail_url,
      durationSeconds: data.duration,
      errorMessage: data.error?.message ?? null,
    };
  }

  /**
   * Verifies the HMAC-SHA256 signature on a webhook payload.
   * HeyGen sends the signature in the `X-HeyGen-Signature` header.
   */
  verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
    if (!this.webhookSecret) {
      this.logger.error(
        'verifyWebhookSignature called but HEYGEN_WEBHOOK_SECRET is not set — rejecting.',
      );
      return false;
    }
    if (!signature) return false;

    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    const provided = signature.toLowerCase().replace(/^sha256=/, '');

    const expectedBuf = Buffer.from(expected, 'hex');
    const providedBuf = Buffer.from(provided, 'hex');
    if (expectedBuf.length !== providedBuf.length) return false;
    return timingSafeEqual(expectedBuf, providedBuf);
  }

  /**
   * POST upload.heygen.com/v1/asset — uploads a binary file and returns the
   * asset_id. Required for files larger than 32MB (digital twin videos pretty
   * much always hit this). Streams from the source URL straight to HeyGen so
   * we don't buffer hundreds of MB in memory.
   */
  async uploadAsset(sourceUrl: string, contentType: string): Promise<string> {
    this.ensureConfigured();

    this.logger.log(`[HEYGEN] uploadAsset sourceUrl=${sourceUrl} contentType=${contentType}`);

    // Fetch the source file as a stream
    const upstream = await fetch(sourceUrl);
    if (!upstream.ok || !upstream.body) {
      throw new Error(
        `Falha ao baixar o arquivo do storage para o upload na HeyGen (status=${upstream.status}).`,
      );
    }

    const contentLength = upstream.headers.get('content-length');
    const headers: Record<string, string> = {
      'X-Api-Key': this.apiKey,
      'Content-Type': contentType,
    };
    if (contentLength) headers['Content-Length'] = contentLength;

    // 10 minute timeout — uploads of 200-500MB videos can take a while
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);

    try {
      const response = await fetch('https://upload.heygen.com/v1/asset', {
        method: 'POST',
        headers,
        body: upstream.body,
        signal: controller.signal,
        // Node fetch requires this when streaming a request body
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });

      if (!response.ok) {
        const errorBody = await response.text();
        this.logger.error(
          `HeyGen asset upload failed status=${response.status} body=${errorBody.slice(0, 300)}`,
        );
        throw new Error(this.friendlyHttpMessage(response.status, errorBody));
      }

      // HeyGen returns { code, data: { id, name, file_url, ... } }
      const json = (await response.json()) as { data?: { id?: string } };
      const assetId = json?.data?.id;
      if (!assetId) {
        this.logger.error(
          `HeyGen asset upload missing id in response: ${JSON.stringify(json).slice(0, 300)}`,
        );
        throw new Error('A HeyGen aceitou o upload mas não retornou um asset_id.');
      }

      this.logger.log(`[HEYGEN] ✅ uploadAsset → asset_id=${assetId}`);
      return assetId;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private ensureConfigured(): void {
    if (!this.apiKey) {
      throw new Error(
        'A integração com HeyGen não está configurada. Entre em contato com o suporte.',
      );
    }
  }

  /**
   * Wraps fetch with timeout + JSON parsing + uniform error handling.
   * Retries once on transient failures (408/429/5xx).
   */
  private async fetchJson<T>(
    url: string,
    init: RequestInit,
    timeoutMs = 60_000,
  ): Promise<T> {
    const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
    const maxAttempts = 2;
    let lastStatus = 0;
    let lastBody = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const response = await this.fetchWithTimeout(
        url,
        { ...init, headers: { ...this.headers(), ...(init.headers ?? {}) } },
        timeoutMs,
      );

      if (response.ok) {
        if (response.status === 204) return {} as T;
        return (await response.json()) as T;
      }

      lastStatus = response.status;
      lastBody = await response.text();

      const shouldRetry = attempt < maxAttempts && transientStatuses.has(response.status);
      if (shouldRetry) {
        this.logger.warn(
          `[HEYGEN_RETRY] ${init.method ?? 'GET'} ${url} attempt=${attempt}/${maxAttempts} status=${response.status} body=${lastBody.slice(0, 200)}`,
        );
        await new Promise((r) => setTimeout(r, 2_000));
        continue;
      }
      break;
    }

    this.logger.error(
      `HeyGen request failed ${init.method ?? 'GET'} ${url} status=${lastStatus} body=${lastBody}`,
    );
    throw new Error(this.friendlyHttpMessage(lastStatus, lastBody));
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': this.apiKey,
    };
  }

  private friendlyHttpMessage(status: number, body: string): string {
    if (status === 401 || status === 403) {
      return 'Credenciais com a HeyGen estão inválidas. Entre em contato com o suporte.';
    }
    if (status === 404) {
      return 'Recurso não encontrado na HeyGen. O avatar pode ter sido removido.';
    }
    if (status === 413) {
      return 'O vídeo é grande demais. Use um arquivo menor (máx. 500MB).';
    }
    if (status === 429) {
      return 'Limite de requisições com a HeyGen atingido. Aguarde alguns segundos e tente de novo.';
    }
    if (status >= 500) {
      return 'O serviço da HeyGen está instável agora. Tente novamente em alguns minutos.';
    }
    const lower = body.toLowerCase();
    if (lower.includes('duration')) {
      return 'O vídeo enviado tem duração inválida. Use um vídeo entre 30s e 5 minutos.';
    }
    if (lower.includes('format') || lower.includes('codec')) {
      return 'Formato de vídeo não suportado. Use MP4 (H.264) com pelo menos 720p.';
    }
    if (lower.includes('consent')) {
      return 'O fluxo de consentimento da HeyGen falhou. Tente recriar o avatar.';
    }
    return 'Não foi possível concluir a operação com a HeyGen. Tente novamente em alguns instantes.';
  }
}
