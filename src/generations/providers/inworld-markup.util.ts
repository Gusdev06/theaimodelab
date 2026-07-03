/**
 * Normaliza tags de emoção/efeito escritas em português ou espanhol para o
 * markup oficial do Inworld TTS 1.5, aplicando também as regras de posição.
 *
 * Referência (sintaxe oficial):
 *  - Emoções (UMA por turno, no INÍCIO):
 *      [happy] [sad] [angry] [surprised] [fearful] [disgusted]
 *  - Estilos de entrega (também no INÍCIO, contam como a "emoção" do turno):
 *      [laughing] [whispering]
 *  - Sons não-verbais (em qualquer posição):
 *      [breathe] [clear_throat] [cough] [laugh] [sigh] [yawn]
 *  - Pausas (em qualquer posição): <break time="2s" /> | <break time="500ms" />
 *
 * O OmniVoice NÃO suporta esse markup — por isso esta função só deve ser
 * aplicada no caminho Inworld. Tags já escritas corretamente em inglês passam
 * intactas.
 */

// Tags de emoção/estilo do Inworld (vão SEMPRE no início; só uma por turno).
const START_TAGS = new Set([
  'happy',
  'sad',
  'angry',
  'surprised',
  'fearful',
  'disgusted',
  'laughing',
  'whispering',
]);

// Sons não-verbais do Inworld (qualquer posição).
const INLINE_TAGS = new Set([
  'breathe',
  'clear_throat',
  'cough',
  'laugh',
  'sigh',
  'yawn',
]);

/**
 * Mapa de sinônimos pt-BR/ES → tag canônica do Inworld.
 * Chaves sem acento e em minúsculas (a entrada é normalizada antes do lookup).
 * Evitamos termos ambíguos entre idiomas (ex.: "enojado" = bravo em ES, mas
 * enojado/nojo em PT) usando apenas formas não conflitantes.
 */
const SYNONYMS: Record<string, string> = {
  // --- Emoções (início) ---
  // happy
  feliz: 'happy',
  alegre: 'happy',
  animado: 'happy',
  animada: 'happy',
  empolgado: 'happy',
  empolgada: 'happy',
  contente: 'happy',
  excited: 'happy',
  emocionado: 'happy',
  emocionada: 'happy',
  // sad
  triste: 'sad',
  chorando: 'sad',
  crying: 'sad',
  choroso: 'sad',
  deprimido: 'sad',
  deprimida: 'sad',
  llorando: 'sad',
  // angry
  bravo: 'angry',
  brava: 'angry',
  irritado: 'angry',
  irritada: 'angry',
  raiva: 'angry',
  furioso: 'angry',
  furiosa: 'angry',
  enfadado: 'angry',
  // surprised
  surpreso: 'surprised',
  surpresa: 'surprised',
  chocado: 'surprised',
  chocada: 'surprised',
  espantado: 'surprised',
  sorprendido: 'surprised',
  asombrado: 'surprised',
  // fearful
  assustado: 'fearful',
  assustada: 'fearful',
  amedrontado: 'fearful',
  asustado: 'fearful',
  temeroso: 'fearful',
  // disgusted
  nojo: 'disgusted',
  nojento: 'disgusted',
  enojado: 'disgusted', // PT: enojado = com nojo
  asqueado: 'disgusted',
  asco: 'disgusted',

  // --- Estilos de entrega (início) ---
  gargalhada: 'laughing',
  gargalhando: 'laughing',
  sussurrando: 'whispering',
  sussurro: 'whispering',
  whispers: 'whispering',
  cochichando: 'whispering',
  susurrando: 'whispering',
  susurro: 'whispering',

  // --- Sons não-verbais (inline) ---
  risos: 'laugh',
  riso: 'laugh',
  risas: 'laugh',
  laughs: 'laugh',
  rindo: 'laugh',
  risada: 'laugh',
  rir: 'laugh',
  suspiro: 'sigh',
  suspirando: 'sigh',
  tosse: 'cough',
  tossindo: 'cough',
  tos: 'cough',
  respira: 'breathe',
  respiracao: 'breathe',
  respirando: 'breathe',
  respiracion: 'breathe',
  bocejo: 'yawn',
  bocejando: 'yawn',
  bostezo: 'yawn',
  pigarro: 'clear_throat',
  pigarrear: 'clear_throat',
};

/**
 * Tags oferecidas no menu de emoções da UI que NÃO têm equivalente no Inworld
 * (sarcástico, cantar, curioso). Como não há markup correspondente, removemos
 * a tag em ambos os caminhos para não ser lida em voz alta. Formas em pt-BR/ES/EN
 * (sem acento, via fold()).
 */
const DROP_TAGS = new Set([
  'sarcastico',
  'sarcastic',
  'cantando',
  'singing',
  'curioso',
  'curious',
]);

/** Remove acentos e baixa a caixa para casar sinônimos de forma robusta. */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Converte uma tag de pausa em português/inglês para SSML do Inworld.
 * Aceita: [pausa 2s] [pause 2s] [pausa 500ms] [pausa] (default 1s).
 * Retorna null se não for uma tag de pausa.
 */
function pauseToBreak(inner: string): string | null {
  const folded = fold(inner);
  if (!/^(pausa|pause|break)\b/.test(folded)) return null;
  const match = folded.match(/(\d+)\s*(ms|s)?/);
  if (!match) return '<break time="1s" />';
  const amount = match[1];
  const unit = match[2] === 'ms' ? 'ms' : 's';
  return `<break time="${amount}${unit}" />`;
}

/**
 * Remove as tags expressivas (reações e pausas) do texto. Usado no caminho
 * OmniVoice, que NÃO suporta esse markup — sem a limpeza, as tags seriam lidas
 * literalmente ("colchete laugh colchete"). Tags reconhecidas em pt-BR/ES/inglês
 * e a pausa SSML <break> são removidas; texto desconhecido entre colchetes é
 * preservado.
 */
export function stripExpressiveMarkup(text: string): string {
  if (!text) return text;

  let result = text
    // Pausa SSML escrita à mão
    .replace(/<break\b[^>]*\/?>/gi, '')
    // Tags entre colchetes reconhecidas (emoção/estilo/não-verbal/pausa)
    .replace(/\[([^\]]+)\]/g, (whole, rawInner: string) => {
      const inner = rawInner.trim();
      if (pauseToBreak(inner)) return '';
      const folded = fold(inner);
      const known =
        START_TAGS.has(folded) ||
        INLINE_TAGS.has(folded) ||
        DROP_TAGS.has(folded) ||
        Boolean(SYNONYMS[folded]);
      return known ? '' : whole;
    });

  // Normaliza espaços/pontuação deixados pela remoção.
  result = result
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .trim();

  return result;
}

export function normalizeInworldMarkup(text: string): string {
  if (!text || !text.includes('[')) {
    // Sem colchetes não há nada para normalizar (SSML <break> escrito à mão já
    // está no formato certo e passa intacto).
    return text;
  }

  let firstStartTag: string | null = null;

  // Substitui cada [conteúdo] por: pausa SSML, tag inline, ou remove a tag de
  // emoção/estilo (que será reinserida no início). Texto desconhecido entre
  // colchetes é preservado como veio.
  const replaced = text.replace(/\[([^\]]+)\]/g, (whole, rawInner: string) => {
    const inner = rawInner.trim();

    // 1) Pausa → SSML <break>
    const asBreak = pauseToBreak(inner);
    if (asBreak) return asBreak;

    // 2) Resolve para uma tag canônica (direto em inglês ou via sinônimo)
    const folded = fold(inner);
    const canonical = START_TAGS.has(folded)
      ? folded
      : INLINE_TAGS.has(folded)
        ? folded
        : SYNONYMS[folded];

    if (!canonical) {
      // Emoção da UI sem equivalente no Inworld → remove (não lê em voz alta).
      if (DROP_TAGS.has(folded)) return '';
      // Não reconhecida: mantém como o usuário escreveu.
      return whole;
    }

    // 3) Tag de emoção/estilo → remove daqui e guarda para o início (só a 1ª)
    if (START_TAGS.has(canonical)) {
      if (!firstStartTag) firstStartTag = canonical;
      return '';
    }

    // 4) Som não-verbal → fica inline, já canônico
    return `[${canonical}]`;
  });

  // Limpa espaços duplos deixados pela remoção das tags de início.
  let result = replaced.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;!?])/g, '$1').trim();

  // Reinsere a (única) emoção/estilo no comecinho do turno.
  if (firstStartTag) {
    result = `[${firstStartTag}] ${result}`.trim();
  }

  return result;
}
