import { accessTokenAllowed, googleAudiences } from '../google-clients';

describe('google-clients', () => {
  describe('googleAudiences', () => {
    it('só o cliente da API quando não há extras (comportamento de hoje)', () => {
      expect(googleAudiences('taml.apps.googleusercontent.com', undefined)).toEqual(['taml.apps.googleusercontent.com']);
    });

    it('soma os extras separados por vírgula, sem espaços nem repetidos', () => {
      expect(googleAudiences('taml', ' funvmake , ,taml,outro ')).toEqual(['taml', 'funvmake', 'outro']);
    });

    it('nada configurado devolve undefined (o verifyIdToken segue como antes)', () => {
      expect(googleAudiences(undefined, '')).toBeUndefined();
      expect(googleAudiences('  ', ' , ')).toBeUndefined();
    });
  });

  describe('accessTokenAllowed', () => {
    const audiences = ['taml', 'funvmake'];

    it('aceita token emitido para um cliente da lista (aud ou azp)', () => {
      expect(accessTokenAllowed({ aud: 'funvmake' }, audiences)).toBe(true);
      expect(accessTokenAllowed({ azp: 'taml', aud: 'outra-coisa' }, audiences)).toBe(true);
    });

    it('recusa token de outro app Google ou sem tokeninfo', () => {
      expect(accessTokenAllowed({ aud: 'app-de-terceiro', azp: 'app-de-terceiro' }, audiences)).toBe(false);
      expect(accessTokenAllowed(null, audiences)).toBe(false);
      expect(accessTokenAllowed({ aud: 123 }, audiences)).toBe(false);
    });

    it('sem lista de clientes não dá para conferir e não bloqueia', () => {
      expect(accessTokenAllowed({ aud: 'qualquer' }, undefined)).toBe(true);
    });
  });
});
