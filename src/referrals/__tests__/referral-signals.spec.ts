import {
  emailFingerprint,
  generateReferralCode,
  hashSignupIp,
  normalizeEmailForFingerprint,
  normalizeReferralCode,
  REFERRAL_CODE_LENGTH,
} from '../referral-signals';

describe('referral-signals', () => {
  describe('normalizeReferralCode', () => {
    it('apara espaços e põe em maiúscula', () => {
      expect(normalizeReferralCode('  ab12cd34 ')).toBe('AB12CD34');
    });

    it('recusa vazio, curto demais, longo demais e caracteres fora do padrão', () => {
      expect(normalizeReferralCode(undefined)).toBeNull();
      expect(normalizeReferralCode('')).toBeNull();
      expect(normalizeReferralCode('abc')).toBeNull();
      expect(normalizeReferralCode('A'.repeat(51))).toBeNull();
      expect(normalizeReferralCode('AB 12')).toBeNull();
      expect(normalizeReferralCode("AB'1;--")).toBeNull();
    });
  });

  describe('generateReferralCode', () => {
    it('gera 8 caracteres sem 0, O, 1, I ou L', () => {
      const code = generateReferralCode(new Uint8Array([0, 1, 2, 3, 250, 251, 252, 255]));
      expect(code).toHaveLength(REFERRAL_CODE_LENGTH);
      expect(code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    });

    it('é determinístico para os mesmos bytes e passa no próprio normalizador', () => {
      const bytes = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]);
      expect(generateReferralCode(bytes)).toBe(generateReferralCode(bytes));
      expect(normalizeReferralCode(generateReferralCode(bytes))).toBe(generateReferralCode(bytes));
    });

    it('recusa bytes de menos', () => {
      expect(() => generateReferralCode(new Uint8Array(3))).toThrow();
    });
  });

  describe('normalizeEmailForFingerprint / emailFingerprint', () => {
    it('tira +tag e, no Gmail, os pontos e o googlemail', () => {
      expect(normalizeEmailForFingerprint('Fu.La.No+promo@Gmail.com')).toBe('fulano@gmail.com');
      expect(normalizeEmailForFingerprint('fulano@googlemail.com')).toBe('fulano@gmail.com');
    });

    it('mantém os pontos fora do Gmail', () => {
      expect(normalizeEmailForFingerprint('fu.lano+x@outlook.com')).toBe('fu.lano@outlook.com');
    });

    it('aliases da mesma caixa dão a mesma impressão; caixas diferentes não', () => {
      expect(emailFingerprint('a.b+1@gmail.com')).toBe(emailFingerprint('ab+2@googlemail.com'));
      expect(emailFingerprint('ab@gmail.com')).not.toBe(emailFingerprint('ab@outlook.com'));
    });

    it('recusa e-mail sem formato', () => {
      expect(emailFingerprint('sem-arroba')).toBeNull();
      expect(emailFingerprint('@gmail.com')).toBeNull();
      expect(emailFingerprint('+tag@gmail.com')).toBeNull();
      expect(emailFingerprint(null)).toBeNull();
    });

    it('nunca devolve o e-mail em claro', () => {
      expect(emailFingerprint('fulano@gmail.com')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('hashSignupIp', () => {
    it('mesmo IP e sal dão o mesmo hash; IPv4 mapeado em IPv6 conta como o mesmo', () => {
      expect(hashSignupIp('203.0.113.7', 's')).toBe(hashSignupIp('::ffff:203.0.113.7', 's'));
    });

    it('sal diferente muda o hash e o IP não aparece', () => {
      const hash = hashSignupIp('203.0.113.7', 's1');
      expect(hash).not.toBe(hashSignupIp('203.0.113.7', 's2'));
      expect(hash).not.toContain('203');
    });

    it('sem IP utilizável, null', () => {
      expect(hashSignupIp(undefined, 's')).toBeNull();
      expect(hashSignupIp('  ', 's')).toBeNull();
      expect(hashSignupIp('unknown', 's')).toBeNull();
    });
  });
});
