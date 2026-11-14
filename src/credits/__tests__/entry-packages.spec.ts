import { entryPackageNames, hasEntryPackage, withoutEntryPackages } from '../entry-packages';

const vitrine = [{ name: 'Mini' }, { name: 'Plus' }, { name: 'Turbo' }];

describe('pacote de entrada', () => {
  it('sem a env, a lista de nomes é vazia e a vitrine não muda', () => {
    const names = entryPackageNames(undefined);
    expect(names.size).toBe(0);
    expect(hasEntryPackage(vitrine, names)).toBe(false);
    expect(withoutEntryPackages(vitrine, names)).toBe(vitrine);
  });

  it('lê vários nomes, sem diferenciar maiúscula nem espaço', () => {
    const names = entryPackageNames(' mini , START ,, ');
    expect([...names]).toEqual(['mini', 'start']);
    expect(hasEntryPackage(vitrine, names)).toBe(true);
  });

  it('tira só o pacote de entrada de quem já pagou', () => {
    const names = entryPackageNames('Mini');
    expect(withoutEntryPackages(vitrine, names).map((p) => p.name)).toEqual(['Plus', 'Turbo']);
  });

  it('nome que não existe na vitrine não tira nada', () => {
    const names = entryPackageNames('Outro');
    expect(hasEntryPackage(vitrine, names)).toBe(false);
    expect(withoutEntryPackages(vitrine, names).map((p) => p.name)).toEqual(['Mini', 'Plus', 'Turbo']);
  });
});
