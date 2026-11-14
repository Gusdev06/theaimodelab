/**
 * Pacote de entrada: o pacote barato que existe só para a 1ª compra (ex.: "Mini").
 * Quem já pagou alguma coisa não o vê na vitrine logada, para não trocar o Plus por ele.
 * A vitrine pública (visitante) mostra sempre. Sem a env ENTRY_PACKAGE_NAMES nada muda.
 */
export function entryPackageNames(raw: string | undefined = process.env.ENTRY_PACKAGE_NAMES): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0),
  );
}

export function hasEntryPackage<T extends { name: string }>(packages: T[], entryNames: Set<string>): boolean {
  return entryNames.size > 0 && packages.some((pkg) => entryNames.has(pkg.name.trim().toLowerCase()));
}

export function withoutEntryPackages<T extends { name: string }>(packages: T[], entryNames: Set<string>): T[] {
  if (entryNames.size === 0) return packages;
  return packages.filter((pkg) => !entryNames.has(pkg.name.trim().toLowerCase()));
}
