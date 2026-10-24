import {
  displayFirstName,
  emailDomainKey,
  emailFingerprint,
  generateReferralCode,
  hashSignupIp,
  ipv6Prefix64,
  isDisposableEmail,
  normalizeEmailForFingerprint,
  normalizeReferralCode,
  parseStrictInt,
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

  describe('parseStrictInt', () => {
    it('aceita só dígitos', () => {
      expect(parseStrictInt('200')).toBe(200);
      expect(parseStrictInt(' 0 ')).toBe(0);
      expect(parseStrictInt(350)).toBe(350);
    });

    it('negativo, letra no meio, notação científica, decimal e vazio viram null (nunca um número por engano)', () => {
      for (const raw of ['-1', '-200', '2OO', '1e3', '2.5', '', ' ', 'abc', '9999999999', null, undefined, {}]) {
        expect(parseStrictInt(raw)).toBeNull();
      }
    });
  });

  describe('e-mail', () => {
    it('tira +tag e, no Gmail, os pontos e o googlemail', () => {
      expect(normalizeEmailForFingerprint('Fu.La.No+promo@Gmail.com')).toBe('fulano@gmail.com');
      expect(normalizeEmailForFingerprint('fulano@googlemail.com')).toBe('fulano@gmail.com');
    });

    it('no Yahoo tira o -palavra do endereço descartável', () => {
      expect(normalizeEmailForFingerprint('fulano-loja1@yahoo.com.br')).toBe('fulano@yahoo.com.br');
      expect(normalizeEmailForFingerprint('fu-lano@outlook.com')).toBe('fu-lano@outlook.com');
    });

    it('mantém os pontos fora do Gmail', () => {
      expect(normalizeEmailForFingerprint('fu.lano+x@outlook.com')).toBe('fu.lano@outlook.com');
    });

    it('aliases da mesma caixa dão a mesma impressão; caixas diferentes não', () => {
      expect(emailFingerprint('a.b+1@gmail.com')).toBe(emailFingerprint('ab+2@googlemail.com'));
      expect(emailFingerprint('ab@gmail.com')).not.toBe(emailFingerprint('ab@outlook.com'));
    });

    it('recusa e-mail sem formato e nunca devolve o e-mail em claro', () => {
      expect(emailFingerprint('sem-arroba')).toBeNull();
      expect(emailFingerprint('@gmail.com')).toBeNull();
      expect(emailFingerprint('+tag@gmail.com')).toBeNull();
      expect(emailFingerprint(null)).toBeNull();
      expect(emailFingerprint('fulano@gmail.com')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('domínio próprio vira chave; provedor público não', () => {
      expect(emailDomainKey('a@gmail.com')).toBeNull();
      expect(emailDomainKey('a@hotmail.com.br')).toBeNull();
      expect(emailDomainKey('a@yahoo.es')).toBeNull();
      const key = emailDomainKey('a@minhafazenda.xyz');
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(emailDomainKey('b@MinhaFazenda.xyz')).toBe(key);
      expect(key).not.toContain('minhafazenda');
    });

    it('caixa temporária, inclusive por subdomínio', () => {
      expect(isDisposableEmail('x@mailinator.com')).toBe(true);
      expect(isDisposableEmail('x@abc.mailinator.com')).toBe(true);
      expect(isDisposableEmail('x@YOPMAIL.com')).toBe(true);
      expect(isDisposableEmail('x@gmail.com')).toBe(false);
      expect(isDisposableEmail('x@notmailinator.com')).toBe(false);
      expect(isDisposableEmail('lixo')).toBe(false);
    });
  });

  describe('IP', () => {
    it('IPv6 vira o /64', () => {
      expect(ipv6Prefix64('2804:14c:5b80:8a1f:1234:5678:9abc:def0')).toBe('2804:14c:5b80:8a1f::/64');
      expect(ipv6Prefix64('2804:14c::1')).toBe('2804:14c:0:0::/64');
      expect(ipv6Prefix64('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
      expect(ipv6Prefix64('1::2::3')).toBeNull();
      expect(ipv6Prefix64('zzzz::1')).toBeNull();
    });

    it('mesmo /64 dá o mesmo hash; /64 diferente não', () => {
      const a = hashSignupIp('2804:14c:5b80:8a1f:1111:2222:3333:4444', 's');
      expect(a).toBe(hashSignupIp('2804:14c:5b80:8a1f:aaaa:bbbb:cccc:dddd', 's'));
      expect(a).not.toBe(hashSignupIp('2804:14c:5b80:8a20::1', 's'));
    });

    it('mesmo IPv4 e sal dão o mesmo hash; IPv4 mapeado em IPv6 conta como o mesmo', () => {
      expect(hashSignupIp('203.0.113.7', 's')).toBe(hashSignupIp('::ffff:203.0.113.7', 's'));
    });

    it('sal diferente muda o hash e o IP não aparece', () => {
      const hash = hashSignupIp('203.0.113.7', 's1');
      expect(hash).not.toBe(hashSignupIp('203.0.113.7', 's2'));
      expect(hash).not.toContain('203');
    });

    it('sem IP utilizável, null (a regra não age em vez de acusar por engano)', () => {
      for (const ip of [undefined, '  ', 'unknown', 'não-é-ip', '1.2.3', '::ffff:zz']) {
        expect(hashSignupIp(ip, 's')).toBeNull();
      }
    });
  });

  describe('displayFirstName', () => {
    it('primeiro nome quando parece nome de verdade', () => {
      expect(displayFirstName('Maria Clara Souza')).toBe('Maria');
      expect(displayFirstName('José')).toBe('José');
      expect(displayFirstName("D'Ávila Lima")).toBe("D'Ávila");
    });

    it('nome que vem do e-mail ou com número vira só a inicial', () => {
      expect(displayFirstName('joao.silva1990')).toBe('J•••');
      expect(displayFirstName('x_99')).toBe('X•••');
      expect(displayFirstName('123abc')).toBe('A•••');
    });

    it('sem nome, vazio (a tela mostra "Amigo")', () => {
      expect(displayFirstName('')).toBe('');
      expect(displayFirstName(null)).toBe('');
      expect(displayFirstName('1234')).toBe('');
    });
  });
});
