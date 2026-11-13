import { existsSync, readFileSync } from 'fs';
import { checkAdultOnly, DEFAULT_AGE_FLOOR, type SafetyOptions } from '../adult-only-rules';

/**
 * A cópia da trava do site precisa dar exatamente o mesmo resultado que o original em cada caso do corpus do red team
 * (furos de ofuscação, idade, gíria pt/en/es e falsos positivos legítimos), com as opções de cada caso. Se este teste
 * quebrar depois de atualizar a cópia, a cópia está diferente do site.
 *
 * O corpus NÃO fica neste repositório (seria um manual de como furar a trava). Ele mora junto da trava original, no
 * qa-e2e/unit/safety-corpus.json do site, e entra pelo caminho em SAFETY_CORPUS_PATH:
 *   SAFETY_CORPUS_PATH=<caminho do safety-corpus.json> npx jest src/content-safety
 * Sem a variável, os dois testes do corpus ficam pulados; o resto da suíte da trava roda sempre.
 */
interface CorpusCase {
  text: string;
  options?: SafetyOptions;
  expect: 'block' | 'pass';
  source?: string;
}

const corpusPath = process.env.SAFETY_CORPUS_PATH;
const corpusAvailable = !!corpusPath && existsSync(corpusPath);
const cases: CorpusCase[] = corpusAvailable
  ? (() => {
      const corpus: unknown = JSON.parse(readFileSync(corpusPath, 'utf8'));
      return (Array.isArray(corpus) ? corpus : (corpus as { cases: CorpusCase[] }).cases) as CorpusCase[];
    })()
  : [];
const corpusIt = corpusAvailable ? it : it.skip;

describe('adult-only-rules (cópia da trava do site)', () => {
  corpusIt('o corpus está completo', () => {
    expect(cases.length).toBeGreaterThan(1000);
  });

  corpusIt('cada caso do corpus dá o resultado esperado', () => {
    const wrong = cases
      .map((c) => ({ c, ok: checkAdultOnly(c.text, c.options ?? {}).ok }))
      .filter(({ c, ok }) => ok !== (c.expect === 'pass'))
      .map(({ c }) => `${c.expect.toUpperCase()} esperado: ${JSON.stringify(c.text)} ${JSON.stringify(c.options ?? {})} [${c.source ?? ''}]`);
    expect(wrong).toEqual([]);
  });

  it('o piso de idade padrão é 18 (regra do dono, 13/11); um piso maior continua possível por opção', () => {
    expect(DEFAULT_AGE_FLOOR).toBe(18);
    expect(checkAdultOnly('a 22 year old woman', { adult: true }).ok).toBe(true);
    expect(checkAdultOnly('a 22 year old woman', { adult: true, floor: 18 }).ok).toBe(true);
    expect(checkAdultOnly('a 17 year old', { adult: true, floor: 18 }).ok).toBe(false);
    expect(checkAdultOnly('a 22 year old woman', { adult: true, floor: 25 }).ok).toBe(false);
    expect(checkAdultOnly('a woman in her early twenties', { adult: true, floor: 25 }).ok).toBe(false);
  });

  describe('idade 18–24 escrita é adulta em todo modo (antes o construtor barrava abaixo de 25)', () => {
    const adultTexts = [
      'mulher de 19 anos, loira, de lingerie',
      'a 22 year old woman, nude, bedroom',
      'Ana, 19, ruiva',
      'modelo de 24 anos na praia',
      'a woman in her early twenties',
      'mulher de vinte e poucos anos',
      'quase 19 anos, mulher adulta',
      'estudante universitária de 20 anos',
      'turning 19 soon, adult woman',
      'faz 18 anos que trabalho como modelo, mulher nua',
    ];
    it.each(adultTexts)('construtor (estrito): %s', (text) => {
      expect(checkAdultOnly(text, { adult: true }).ok).toBe(true);
    });
    it.each(adultTexts)('pedido livre: %s', (text) => {
      expect(checkAdultOnly(text, { adult: true, free: true }).ok).toBe(true);
    });
  });

  describe('menor continua barrando do mesmo jeito (piso 18)', () => {
    const minorTexts = [
      'garota de 16 anos de lingerie',
      'a 17 year old girl',
      'Valentina, 17, loira',
      'quase 18 anos, nua',
      'about to turn 18',
      'under 21, nude',
      'teen girl nude',
      'novinha de 16 anos',
      'just turned 18',
      'colegial do ensino medio',
      // aniversário que ainda vem: hoje tem 17 (com o piso de 25 o número sozinho barrava; agora é regra própria)
      'turning 18 soon',
      'turns 18 years old next month',
      'she will turn 18 tomorrow',
      'faz 18 anos mês que vem',
      'cumple 18 en marzo',
    ];
    it.each(minorTexts)('construtor (estrito): %s', (text) => {
      expect(checkAdultOnly(text, { adult: true }).ok).toBe(false);
    });
    it.each(minorTexts)('pedido livre: %s', (text) => {
      expect(checkAdultOnly(text, { adult: true, free: true }).ok).toBe(false);
    });
    it('no construtor a gíria sozinha segue barrando (schoolgirl, novinha)', () => {
      expect(checkAdultOnly('schoolgirl', { adult: true }).ok).toBe(false);
      expect(checkAdultOnly('novinha', { adult: true }).ok).toBe(false);
    });
  });
});
