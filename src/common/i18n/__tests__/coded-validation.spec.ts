import { BadRequestException } from '@nestjs/common';
import { CodedValidationPipe } from '../coded-validation';
import { RegisterDto } from '../../../auth/dto/register.dto';
import { VerifyEmailDto } from '../../../auth/dto/verify-email.dto';

/** C-04: erro do cadastro com código estável (o texto sai do i18n; fora de request, t() devolve a chave). */
async function validate(metatype: unknown, value: unknown, options = {}) {
  const pipe = new CodedValidationPipe({ whitelist: true, transform: true, ...options });
  try {
    await pipe.transform(value, { type: 'body', metatype: metatype as never });
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as Record<string, unknown>;
  }
}

describe('CodedValidationPipe', () => {
  it('senha fraca devolve PASSWORD_WEAK e mantém message como lista', async () => {
    const body = await validate(RegisterDto, { email: 'ana@mail.com', name: 'Ana', password: 'semnumeroaqui' });
    expect(body).toMatchObject({ statusCode: 400, error: 'Bad Request', code: 'PASSWORD_WEAK' });
    expect(body?.message).toEqual(['errors.validation.PASSWORD_WEAK']);
  });

  it('e-mail inválido devolve EMAIL_INVALID', async () => {
    const body = await validate(RegisterDto, { email: 'nao-e-email', name: 'Ana', password: 'Senha1234' });
    expect(body?.code).toBe('EMAIL_INVALID');
  });

  it('código com letra devolve um código de CODE_*', async () => {
    const body = await validate(VerifyEmailDto, { code: '12a456' });
    expect(String(body?.code)).toMatch(/^CODE_/);
  });

  it('cadastro válido passa', async () => {
    await expect(validate(RegisterDto, { email: 'ana@mail.com', name: 'Ana', password: 'Senha1234' })).resolves.toBeNull();
  });

  it('erro sem código (campo a mais) sai no formato antigo, sem code', async () => {
    const body = await validate(VerifyEmailDto, { code: '123456', extra: 'x' }, { forbidNonWhitelisted: true });
    expect(body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
    expect(body).not.toHaveProperty('code');
  });
});
