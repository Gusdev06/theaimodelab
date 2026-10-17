import { existsSync, readFileSync } from 'fs';
import { checkAdultOnly, type SafetyOptions } from '../adult-only-rules';

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

  it('o piso de idade é opção: 25 no construtor, 18 na API', () => {
    expect(checkAdultOnly('a 22 year old woman', { adult: true }).ok).toBe(false);
    expect(checkAdultOnly('a 22 year old woman', { adult: true, floor: 18 }).ok).toBe(true);
    expect(checkAdultOnly('a 17 year old', { adult: true, floor: 18 }).ok).toBe(false);
  });
});
