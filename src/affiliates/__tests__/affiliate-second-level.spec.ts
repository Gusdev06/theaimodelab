import {
  AFFILIATE_SECOND_LEVEL_MAX_PERCENT,
  computeSecondLevelCommissionCents,
  resolveSecondLevelPercent,
} from '../affiliate-second-level';

/**
 * Segundo nível do programa de afiliados: desligado sem a env AFFILIATE_SECOND_LEVEL_PERCENT;
 * ligado, o pai recebe a fatia sobre a comissão direta do filho.
 */
describe('resolveSecondLevelPercent', () => {
  it.each([undefined, null, '', '   ', '0', '0.0', '-5', 'abc', '5%', '5,5', '1e1'])(
    'desligado para %p',
    (raw) => {
      expect(resolveSecondLevelPercent(raw as string | undefined)).toBe(0);
    },
  );

  it('aceita inteiro e decimal com ponto', () => {
    expect(resolveSecondLevelPercent('5')).toBe(5);
    expect(resolveSecondLevelPercent(' 2.5 ')).toBe(2.5);
    expect(resolveSecondLevelPercent('0.01')).toBe(0.01);
  });

  it('acima do teto vale o teto', () => {
    expect(resolveSecondLevelPercent('20')).toBe(AFFILIATE_SECOND_LEVEL_MAX_PERCENT);
    expect(resolveSecondLevelPercent('99')).toBe(AFFILIATE_SECOND_LEVEL_MAX_PERCENT);
  });
});

describe('computeSecondLevelCommissionCents', () => {
  it('arredonda a fatia da comissão direta', () => {
    expect(computeSecondLevelCommissionCents(1138, 5)).toBe(57); // 56,9
    expect(computeSecondLevelCommissionCents(1000, 2.5)).toBe(25);
    expect(computeSecondLevelCommissionCents(1000, 20)).toBe(200);
  });

  it('zero quando a fatia não chega a um centavo ou não há o que dividir', () => {
    expect(computeSecondLevelCommissionCents(1138, 0.01)).toBe(0);
    expect(computeSecondLevelCommissionCents(0, 5)).toBe(0);
    expect(computeSecondLevelCommissionCents(-100, 5)).toBe(0);
    expect(computeSecondLevelCommissionCents(1138, 0)).toBe(0);
  });
});
