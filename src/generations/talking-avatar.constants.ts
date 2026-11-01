/**
 * Avatar falante (OmniHuman 1.5 na WaveSpeed): a pessoa da foto fala o texto com boca e gesto sincronizados.
 * Cadeia: texto → voz (TTS Inworld 1.5 Max pela WaveSpeed, a mesma do /text-to-speech) → OmniHuman (foto + áudio).
 *
 * Preço do provedor (docs da WaveSpeed, 30/10/2026): US$ 0,25 por segundo de áudio gerado. Na regra de preço da
 * plataforma (créditos = custo em US$ × 3.333, ~70% de margem no Studio/Agency mensal) dá 833 créditos/s; fica 850
 * para cobrir o TTS (35 créditos) e a variação do áudio. A cobrança é por estimativa no envio, pelo tamanho do
 * texto (como o avatar da HeyGen, avatars.constants.ts): ~11 caracteres por segundo com folga para o estimado
 * ficar ACIMA do real. Piso de 3 s. O modelo não cobra por resolução.
 */
export const TALKING_AVATAR_MODEL = 'bytedance/avatar-omni-human-1.5';
export const TALKING_AVATAR_SLUG = 'talking-avatar';
export const TALKING_AVATAR_CREDITS_PER_SECOND = 850;
export const TALKING_AVATAR_CHARS_PER_SECOND = 11;
export const TALKING_AVATAR_MIN_SECONDS = 3;
/** 300 caracteres ≈ 27 s: teto do texto (o OmniHuman cobra por segundo, e 30 s já é o formato longo do TikTok) */
export const TALKING_AVATAR_MAX_CHARS = 300;

export type TalkingAvatarLanguage = 'pt' | 'en' | 'es';

/**
 * Voz padrão por idioma quando o site não manda `voice_id`: vozes femininas da lista permitida do Inworld
 * (inworld-voices.service.ts), que a WaveSpeed sintetiza sem a chave do catálogo (TKT-027 só derruba a listagem).
 */
export const TALKING_AVATAR_DEFAULT_VOICE: Record<TalkingAvatarLanguage, string> = {
  pt: 'inworld:Maitê',
  en: 'inworld:Olivia',
  es: 'inworld:Lupita',
};

export function talkingAvatarSeconds(textLength: number): number {
  return Math.max(TALKING_AVATAR_MIN_SECONDS, Math.ceil(textLength / TALKING_AVATAR_CHARS_PER_SECOND));
}

/** Créditos cobrados no envio: segundos estimados × preço por segundo (inteiro). */
export function estimateTalkingAvatarCost(textLength: number): number {
  return Math.ceil(talkingAvatarSeconds(textLength) * TALKING_AVATAR_CREDITS_PER_SECOND);
}

export function talkingAvatarVoiceFor(language: string | undefined, voiceId: string | undefined): string {
  if (voiceId && voiceId.trim()) return voiceId.trim();
  const lang = (language ?? 'pt').toLowerCase().slice(0, 2) as TalkingAvatarLanguage;
  return TALKING_AVATAR_DEFAULT_VOICE[lang] ?? TALKING_AVATAR_DEFAULT_VOICE.pt;
}

/**
 * Planos que podem usar o avatar falante (decisão do dono, 30/10/2026): nasce só para Studio e Agency, porque o
 * vídeo custa 3,5× o Veo pelo mesmo tempo de fala. Env `TALKING_AVATAR_PLANS` troca a lista sem deploy
 * (slugs separados por vírgula; `all` libera qualquer conta). O plano anual conta como o mensal irmão (`studio-anual`).
 */
export const TALKING_AVATAR_DEFAULT_PLANS: readonly string[] = ['studio', 'agency'];

export function talkingAvatarPlansFrom(envValue: string | undefined): string[] {
  const raw = (envValue ?? '').trim();
  if (!raw) return [...TALKING_AVATAR_DEFAULT_PLANS];
  return raw
    .split(',')
    .map((slug) => slug.trim().toLowerCase())
    .filter(Boolean);
}

/** `all` (ou `*`) na lista libera todo mundo, inclusive sem assinatura. */
export function talkingAvatarPlanAllowed(planSlug: string | null | undefined, plans: readonly string[]): boolean {
  if (plans.some((slug) => slug === 'all' || slug === '*')) return true;
  if (!planSlug) return false;
  const base = planSlug.toLowerCase().replace(/-anual$/, '');
  return plans.includes(base) || plans.includes(planSlug.toLowerCase());
}
