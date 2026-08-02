import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Autenticação OPCIONAL: tenta validar o JWT (Bearer) e, se válido, popula
 * `request.user` (com `sub`, `email`, `role`). Se não houver token, ou o token for
 * inválido/expirado, NÃO lança — a request segue como anônima (`request.user`
 * undefined).
 *
 * Uso: combine com `@Public()` no handler (para o `JwtAuthGuard` global deixar
 * passar) e aplique este guard via `@UseGuards(OptionalJwtAuthGuard)` para
 * preencher o usuário quando houver credencial.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  // Sobrescreve para nunca lançar quando não há usuário: retorna o user (ou
  // undefined). Assinatura genérica para casar com a do Passport.
  handleRequest<TUser = any>(_err: any, user: any): TUser {
    return (user as TUser) ?? (undefined as unknown as TUser);
  }
}
