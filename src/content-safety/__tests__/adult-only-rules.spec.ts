import { readFileSync } from 'fs';
import { join } from 'path';
import { checkAdultOnly, type SafetyOptions } from '../adult-only-rules';

/**
 * A cópia da trava do site precisa dar exatamente o mesmo resultado que o original em cada caso do corpus do red team
 * (1.099 textos: furos de ofuscação, idade, gíria pt/en/es e falsos positivos legítimos), com as opções de cada caso.
 * Se este teste quebrar depois de atualizar a cópia, a cópia está diferente do site.
 */
interface CorpusCase {
  text: string;
  options?: SafetyOptions;
  expect: 'block' | 'pass';
  source?: string;
}

const corpus: unknown = JSON.parse(readFileSync(join(__dirname, 'safety-corpus.json'), 'utf8'));
const cases = (Array.isArray(corpus) ? corpus : (corpus as { cases: CorpusCase[] }).cases) as CorpusCase[];

describe('adult-only-rules (cópia da trava do site)', () => {
  it('o corpus está completo', () => {
    expect(cases.length).toBeGreaterThan(1000);
  });

  it('cada caso do corpus dá o resultado esperado', () => {
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
