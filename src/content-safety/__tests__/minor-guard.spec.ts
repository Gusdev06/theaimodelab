import { assessBody, assessText, collectTexts, normalize } from '../minor-guard';

/**
 * Trava a guarda de menores nos dois sentidos: o que TEM de bloquear (pt/en/es, idade por número e por extenso,
 * leetspeak) e os prompts adultos legítimos que NÃO podem ser bloqueados (guarda que dá falso positivo é desligada).
 */
describe('minor-guard', () => {
  describe('bloqueia referência a menor', () => {
    const mustBlock = [
      'a teen girl on the beach',
      'linda novinha na praia',
      'garota de 16 anos',
      '16yo model',
      '15 year old',
      'girl aged 15',
      'idade 14',
      'una niña en la playa',
      'NIÑOS jugando',
      'colegiala',
      'little girl',
      'young boy',
      'child',
      'menor de idade',
      'menor de edad',
      'uniforme escolar',
      'school uniform',
      'fifteen years old',
      'quinze anos de idade',
      'quince años',
      'k1d',
      't33n',
      'TEEN!',
      '15 years of age',
      'loli style',
      'barely legal',
      'criança',
      'adolescente',
    ];
    it.each(mustBlock)('%s', (text) => {
      expect(assessText(text).blocked).toBe(true);
    });
  });

  describe('NÃO bloqueia prompt adulto legítimo', () => {
    const mustPass = [
      'a 25 year old woman in a red dress',
      '18 years old model, studio light',
      'mulher de 30 anos, praia',
      'mujer de 28 años en Madrid',
      'nurse with 5 years of experience',
      'photo from 10 years ago',
      'foto de 10 anos atrás',
      'minor scratches on the car door',
      '4k 16:9 portrait, 85mm',
      'pack de 12 fotos',
      'mulher com 15 tatuagens',
      'cor secundária vermelha',
      'Nina, a 25 year old woman',
      'meet Nina, my AI model',
      'kidding aside, cinematic look',
      'mujer bebe vino tinto',
      'school teacher in her 40s',
      'university student, 22',
      'late 20s, confident',
      'between two worlds',
    ];
    it.each(mustPass)('%s', (text) => {
      expect(assessText(text)).toEqual({ blocked: false });
    });
  });

  it('normaliza acento e leetspeak de dígito', () => {
    expect(normalize('Crïança T33N')).toBe('crianca teen');
  });

  it('varre o corpo inteiro mas ignora imagem em base64, URL e ids', () => {
    const body = {
      prompt: 'portrait of a woman',
      negative_prompt: 'blurry',
      images: [{ base64: 'A'.repeat(500), mime_type: 'image/png' }],
      reference_url: 'https://cdn.example.com/teen.jpg',
      user_id: 'teen',
      nested: { script: 'she is a teen' },
    };
    expect(collectTexts(body)).toEqual(['portrait of a woman', 'blurry', 'she is a teen']);
    expect(assessBody(body)).toMatchObject({ blocked: true, reason: 'term', match: 'teen' });
  });

  it('corpo sem texto livre não bloqueia', () => {
    expect(assessBody({ resolution: '2K', aspect_ratio: '9:16' })).toEqual({ blocked: false });
    expect(assessBody(null)).toEqual({ blocked: false });
  });

  it('registra a idade que disparou', () => {
    expect(assessText('garota de 16 anos')).toMatchObject({ blocked: true, reason: 'age', match: '16' });
  });
});
