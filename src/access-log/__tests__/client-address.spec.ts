import {
  buildProxyTrust,
  forwardedChain,
  normalizeIp,
  parseTrustedProxyList,
  resolveClientAddress,
  TRUST_NO_PROXY,
  validPort,
} from '../client-address';

/**
 * Endereço do cliente para o registro de acesso. Só IPs de documentação (RFC 5737 e 3849): 192.0.2.x, 198.51.100.x,
 * 203.0.113.x e 2001:db8::/32. O cliente é sempre 203.0.113.7; o resto é proxy ou atacante.
 */

const CLIENT = '203.0.113.7';
const VERCEL = '198.51.100.20';
const ATTACKER = '192.0.2.66';

function listTrust(raw: string) {
  const warnings: string[] = [];
  const parsed = parseTrustedProxyList(raw, warnings);
  return { trust: buildProxyTrust(null, parsed), warnings, parsed };
}

describe('normalizeIp', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['  203.0.113.7  ', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:203.0.113.7', '203.0.113.7'],
    ['203.0.113.7:51234', '203.0.113.7'],
    ['[2001:DB8::1]:443', '2001:db8::1'],
    ['[2001:db8::1]', '2001:db8::1'],
    ['fe80::1%eth0', 'fe80::1'],
    ['2001:db8::1', '2001:db8::1'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeIp(raw)).toBe(expected);
  });

  it.each([
    ['unknown'],
    [''],
    ['999.1.1.1'],
    ['203.0.113'],
    ['<script>'],
    [undefined],
    [42],
    ['1'.repeat(80)],
  ])('não é IP: %p', (raw) => {
    expect(normalizeIp(raw)).toBeNull();
  });
});

describe('validPort', () => {
  it('aceita 1 a 65535 em número ou texto só com dígitos', () => {
    expect(validPort(51234)).toBe(51234);
    expect(validPort('51234')).toBe(51234);
    expect(validPort(' 443 ')).toBe(443);
    expect(validPort(1)).toBe(1);
    expect(validPort(65535)).toBe(65535);
  });

  it('recusa zero, fora da faixa, fração e texto', () => {
    for (const raw of [
      0,
      65536,
      70000,
      1.5,
      -1,
      '0',
      '70000',
      'abc',
      '443abc',
      '',
      null,
      undefined,
    ]) {
      expect(validPort(raw)).toBeNull();
    }
  });
});

describe('forwardedChain', () => {
  it('lê da direita (proxy mais próximo) para a esquerda, somando as linhas do cabeçalho', () => {
    expect(forwardedChain(`${CLIENT}, ${VERCEL}`)).toEqual([VERCEL, CLIENT]);
    expect(forwardedChain([`${ATTACKER}`, `${CLIENT}`])).toEqual([
      CLIENT,
      ATTACKER,
    ]);
    expect(forwardedChain(' , ')).toEqual([]);
    expect(forwardedChain(undefined)).toEqual([]);
  });

  it('cabeçalho gigante: só as 20 entradas mais próximas', () => {
    const many = Array.from(
      { length: 50 },
      (_, index) => `192.0.2.${index}`,
    ).join(',');
    const chain = forwardedChain(many);
    expect(chain).toHaveLength(20);
    expect(chain[0]).toBe('192.0.2.49');
  });
});

describe('parseTrustedProxyList', () => {
  it('aceita nomes, IP solto e faixas, e avisa o que não entende', () => {
    const { parsed, warnings } = listTrust(
      'loopback, 10.0.0.0/8, 198.51.100.20, 2001:db8::/32, banana, 10.0.0.0/0, 1.2.3.4/33',
    );
    expect(parsed?.entries).toEqual([
      'loopback',
      '10.0.0.0/8',
      '198.51.100.20',
      '2001:db8::/32',
    ]);
    expect(warnings).toHaveLength(3);
    expect(warnings.join(' ')).toMatch(/banana/);
    expect(warnings.join(' ')).toMatch(/\/0/);
  });

  it('nome herdado do Object não vira entrada', () => {
    const warnings: string[] = [];
    expect(
      parseTrustedProxyList('constructor,__proto__,toString', warnings),
    ).toBeNull();
    expect(warnings).toHaveLength(3);
  });

  it('lista só com lixo devolve null', () => {
    expect(parseTrustedProxyList('a, b', [])).toBeNull();
  });
});

describe('buildProxyTrust', () => {
  it('sem saltos nem lista, ou com 0 saltos: ninguém é proxy', () => {
    expect(buildProxyTrust(null, null)).toBe(TRUST_NO_PROXY);
    expect(buildProxyTrust(0, parseTrustedProxyList('loopback', []))).toBe(
      TRUST_NO_PROXY,
    );
  });

  it('saltos: confia nos N primeiros, seja quem for', () => {
    const trust = buildProxyTrust(2, null);
    expect(trust(ATTACKER, 0)).toBe(true);
    expect(trust(ATTACKER, 1)).toBe(true);
    expect(trust(ATTACKER, 2)).toBe(false);
  });

  it('lista + saltos: precisa estar na lista E dentro do limite', () => {
    const trust = buildProxyTrust(
      1,
      parseTrustedProxyList('loopback, 198.51.100.0/24', []),
    );
    expect(trust('127.0.0.1', 0)).toBe(true);
    expect(trust('::ffff:127.0.0.1', 0)).toBe(true);
    expect(trust(VERCEL, 1)).toBe(false);
    expect(trust(ATTACKER, 0)).toBe(false);
  });

  it('lista sem limite: anda enquanto o salto estiver na lista; lixo nunca é proxy', () => {
    const trust = buildProxyTrust(
      null,
      parseTrustedProxyList('loopback, 198.51.100.0/24', []),
    );
    expect(trust(VERCEL, 5)).toBe(true);
    expect(trust('unknown', 0)).toBe(false);
    expect(trust('::1', 0)).toBe(true);
  });
});

describe('resolveClientAddress', () => {
  it('sem proxy declarado: cabeçalhos ignorados, vale o socket (IP e porta)', () => {
    const address = resolveClientAddress(
      {
        remoteAddress: `::ffff:${CLIENT}`,
        remotePort: 51234,
        forwardedFor: '192.0.2.1',
        realIp: '192.0.2.2',
        sourcePort: '1111',
      },
      TRUST_NO_PROXY,
    );
    expect(address).toEqual({
      ip: CLIENT,
      port: 51234,
      hops: 0,
      source: 'socket',
    });
  });

  it('1 salto confiável (proxy do VPS que viu o cliente): IP do x-forwarded-for e porta do cabeçalho do proxy', () => {
    const address = resolveClientAddress(
      {
        remoteAddress: '127.0.0.1',
        remotePort: 40000,
        forwardedFor: CLIENT,
        sourcePort: '51234',
      },
      buildProxyTrust(1, null),
    );
    expect(address).toEqual({
      ip: CLIENT,
      port: 51234,
      hops: 1,
      source: 'x-forwarded-for',
    });
  });

  it('cliente que forja o x-forwarded-for atrás de 1 proxy: vale a entrada que o proxy escreveu (a mais à direita)', () => {
    const address = resolveClientAddress(
      {
        remoteAddress: '127.0.0.1',
        forwardedFor: `${ATTACKER}, ${CLIENT}`,
        sourcePort: '51234',
      },
      buildProxyTrust(1, null),
    );
    expect(address.ip).toBe(CLIENT);
    expect(address.hops).toBe(1);
  });

  it('2 saltos (rewrite da Vercel + proxy do VPS): IP do cliente, porta desconhecida (o cabeçalho seria a da Vercel)', () => {
    const address = resolveClientAddress(
      {
        remoteAddress: '127.0.0.1',
        remotePort: 40000,
        forwardedFor: `${CLIENT}, ${VERCEL}`,
        sourcePort: '61000',
      },
      buildProxyTrust(2, null),
    );
    expect(address).toEqual({
      ip: CLIENT,
      port: null,
      hops: 2,
      source: 'x-forwarded-for',
    });
  });

  it('lista: socket fora da lista é o cliente, mesmo mandando x-forwarded-for, x-real-ip e porta', () => {
    const { trust } = listTrust('loopback, 198.51.100.0/24');
    const address = resolveClientAddress(
      {
        remoteAddress: ATTACKER,
        remotePort: 5555,
        forwardedFor: CLIENT,
        realIp: CLIENT,
        sourcePort: '1',
      },
      trust,
    );
    expect(address).toEqual({
      ip: ATTACKER,
      port: 5555,
      hops: 0,
      source: 'socket',
    });
  });

  it('lista: anda pelos proxies da lista e para no primeiro endereço de fora', () => {
    const { trust } = listTrust('loopback, 198.51.100.0/24');
    const address = resolveClientAddress(
      {
        remoteAddress: '127.0.0.1',
        forwardedFor: `${ATTACKER}, ${CLIENT}, ${VERCEL}`,
      },
      trust,
    );
    expect(address.ip).toBe(CLIENT);
    expect(address.hops).toBe(2);
    expect(address.port).toBeNull();
  });

  it('todos os saltos confiáveis: o cliente é a entrada mais distante', () => {
    const address = resolveClientAddress(
      { remoteAddress: '127.0.0.1', forwardedFor: `${CLIENT}, ${VERCEL}` },
      buildProxyTrust(5, null),
    );
    expect(address.ip).toBe(CLIENT);
  });

  it('proxy confiável sem x-forwarded-for: vale o x-real-ip escrito por ele (com a porta dele)', () => {
    const address = resolveClientAddress(
      { remoteAddress: '127.0.0.1', realIp: CLIENT, sourcePort: '51234' },
      buildProxyTrust(1, null),
    );
    expect(address).toEqual({
      ip: CLIENT,
      port: 51234,
      hops: 1,
      source: 'x-real-ip',
    });
  });

  it('com x-forwarded-for, o x-real-ip é ignorado', () => {
    const address = resolveClientAddress(
      { remoteAddress: '127.0.0.1', forwardedFor: CLIENT, realIp: ATTACKER },
      buildProxyTrust(1, null),
    );
    expect(address.ip).toBe(CLIENT);
  });

  it('proxy confiável sem cabeçalho nenhum (ex.: checagem de saúde local): fica o socket', () => {
    const address = resolveClientAddress(
      { remoteAddress: '127.0.0.1', remotePort: 40000 },
      buildProxyTrust(1, null),
    );
    expect(address).toEqual({
      ip: '127.0.0.1',
      port: 40000,
      hops: 0,
      source: 'socket',
    });
  });

  it('lixo no lugar do IP vindo do proxy confiável: IP desconhecido, nunca o do proxy', () => {
    const address = resolveClientAddress(
      {
        remoteAddress: '127.0.0.1',
        forwardedFor: 'unknown',
        sourcePort: '51234',
      },
      buildProxyTrust(1, null),
    );
    expect(address).toEqual({
      ip: null,
      port: null,
      hops: 1,
      source: 'x-forwarded-for',
    });
  });

  it('porta inválida no cabeçalho vira null; IPv6 do cliente sai normalizado', () => {
    const address = resolveClientAddress(
      {
        remoteAddress: '::1',
        forwardedFor: '[2001:DB8::7]:51234',
        sourcePort: '99999',
      },
      buildProxyTrust(1, null),
    );
    expect(address).toEqual({
      ip: '2001:db8::7',
      port: null,
      hops: 1,
      source: 'x-forwarded-for',
    });
  });

  it('função de confiança que lança: tratada como não confiável', () => {
    const address = resolveClientAddress(
      { remoteAddress: CLIENT, forwardedFor: ATTACKER },
      () => {
        throw new Error('falha');
      },
    );
    expect(address.ip).toBe(CLIENT);
  });

  it('sem socket: nada a gravar', () => {
    expect(resolveClientAddress({}, buildProxyTrust(1, null))).toEqual({
      ip: null,
      port: null,
      hops: 0,
      source: 'socket',
    });
  });
});
