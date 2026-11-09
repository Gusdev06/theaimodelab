import { PrismaService } from '../prisma/prisma.service';

/**
 * Declaração de responsabilidade pelas imagens: a cliente marca UMA vez, na primeira criação com foto, que é
 * responsável pelas imagens que envia e que não está subindo imagem de terceiro. Fica gravada na conta
 * (users.image_declaration_at / image_declaration_version) e a data nunca é trocada.
 *
 * Mudar o texto da declaração = acrescentar a data nova em IMAGE_DECLARATION_VERSIONS e trocar a constante vigente
 * (mesmo desenho de terms.constants.ts). O site manda a versão que mostrou; versão que a API não conhece é recusada.
 */
export const CURRENT_IMAGE_DECLARATION_VERSION = '2026-11-06';

/** Todas as versões já publicadas, da mais antiga para a mais nova (AAAA-MM-DD). */
export const IMAGE_DECLARATION_VERSIONS: readonly string[] = [CURRENT_IMAGE_DECLARATION_VERSION];

export function isKnownImageDeclarationVersion(version: unknown): version is string {
  return typeof version === 'string' && IMAGE_DECLARATION_VERSIONS.includes(version);
}

export interface ImageDeclaration {
  imageDeclarationAt: Date | null;
  imageDeclarationVersion: string | null;
}

type ImageDeclarationDb = Pick<PrismaService, 'user'>;

const DECLARATION_FIELDS = { imageDeclarationAt: true, imageDeclarationVersion: true } as const;

/** Declaração gravada na conta (null = a conta não existe). */
export async function readImageDeclaration(db: ImageDeclarationDb, userId: string): Promise<ImageDeclaration | null> {
  return db.user.findUnique({ where: { id: userId }, select: DECLARATION_FIELDS });
}

/**
 * Grava a declaração só se a conta ainda não tem. A condição `imageDeclarationAt: null` é a trava: dois pedidos
 * juntos gravam uma vez só, e quem já declarou fica com a data e a versão originais. Devolve o que ficou gravado.
 */
export async function recordImageDeclaration(
  db: ImageDeclarationDb,
  userId: string,
  version: string,
  now: Date = new Date(),
): Promise<ImageDeclaration | null> {
  await db.user.updateMany({
    where: { id: userId, imageDeclarationAt: null },
    data: { imageDeclarationAt: now, imageDeclarationVersion: version },
  });
  return readImageDeclaration(db, userId);
}
