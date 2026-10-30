import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { GenerateTalkingAvatarDto } from '../dto/generate-talking-avatar.dto';
import {
  TALKING_AVATAR_CREDITS_PER_SECOND,
  TALKING_AVATAR_MAX_CHARS,
  TALKING_AVATAR_MIN_SECONDS,
  estimateTalkingAvatarCost,
  talkingAvatarSeconds,
  talkingAvatarVoiceFor,
} from '../talking-avatar.constants';
import { WavespeedVideoProvider } from '../providers/wavespeed-video.provider';

describe('avatar falante (OmniHuman 1.5)', () => {
  describe('cobrança por estimativa do texto', () => {
    it('piso de 3 s e ~11 caracteres por segundo, sempre arredondando para cima', () => {
      expect(talkingAvatarSeconds(0)).toBe(TALKING_AVATAR_MIN_SECONDS);
      expect(talkingAvatarSeconds(33)).toBe(3);
      expect(talkingAvatarSeconds(34)).toBe(4);
      expect(talkingAvatarSeconds(150)).toBe(14);
      expect(talkingAvatarSeconds(TALKING_AVATAR_MAX_CHARS)).toBe(28);
    });

    it('custo = segundos × créditos por segundo (inteiro)', () => {
      expect(estimateTalkingAvatarCost(10)).toBe(3 * TALKING_AVATAR_CREDITS_PER_SECOND);
      expect(estimateTalkingAvatarCost(150)).toBe(14 * TALKING_AVATAR_CREDITS_PER_SECOND);
      expect(Number.isInteger(estimateTalkingAvatarCost(77))).toBe(true);
    });

    it('voz: a enviada vence; sem ela, a padrão do idioma; idioma desconhecido cai no pt', () => {
      expect(talkingAvatarVoiceFor('en', ' inworld:Alex ')).toBe('inworld:Alex');
      expect(talkingAvatarVoiceFor('en', undefined)).toBe('inworld:Olivia');
      expect(talkingAvatarVoiceFor('es', '')).toBe('inworld:Lupita');
      expect(talkingAvatarVoiceFor('pt-BR', undefined)).toBe('inworld:Maitê');
      expect(talkingAvatarVoiceFor(undefined, undefined)).toBe('inworld:Maitê');
      expect(talkingAvatarVoiceFor('xx', undefined)).toBe('inworld:Maitê');
    });
  });

  describe('DTO', () => {
    const valid = { image: 'AAAA', text: 'Oi, esse é o meu produto favorito.', language: 'pt', consent_confirmed: true };

    it('aceita o pedido mínimo e normaliza a velocidade', () => {
      const dto = plainToInstance(GenerateTalkingAvatarDto, { ...valid, speed: '1.2' });
      expect(validateSync(dto)).toHaveLength(0);
      expect(dto.speed).toBe(1.2);
    });

    it('recusa texto acima do teto, idioma fora da lista, velocidade fora da faixa e foto ausente', () => {
      const long = plainToInstance(GenerateTalkingAvatarDto, { ...valid, text: 'x'.repeat(TALKING_AVATAR_MAX_CHARS + 1) });
      expect(validateSync(long).map((e) => e.property)).toEqual(['text']);
      const lang = plainToInstance(GenerateTalkingAvatarDto, { ...valid, language: 'fr' });
      expect(validateSync(lang).map((e) => e.property)).toEqual(['language']);
      const speed = plainToInstance(GenerateTalkingAvatarDto, { ...valid, speed: 3 });
      expect(validateSync(speed).map((e) => e.property)).toEqual(['speed']);
      const noImage = plainToInstance(GenerateTalkingAvatarDto, { text: 'oi oi', consent_confirmed: true });
      expect(validateSync(noImage).map((e) => e.property)).toEqual(['image']);
    });
  });

  describe('provedor WaveSpeed', () => {
    function provider(fetchImpl: typeof fetch) {
      const config = { get: (key: string, fallback?: string) => (key === 'WAVESPEED_API_KEY' ? 'k' : fallback) };
      const uploads = { uploadBuffer: jest.fn().mockResolvedValue('https://cdn.test/generations/g1/output_0.mp4') };
      global.fetch = fetchImpl;
      return { instance: new WavespeedVideoProvider(config as never, uploads as never), uploads };
    }

    it('manda foto e áudio ao avatar-omni-human-1.5, espera a predição e guarda o vídeo', async () => {
      const calls: Array<{ url: string; body?: unknown }> = [];
      const fetchImpl = jest.fn(async (url: string | URL, init?: RequestInit) => {
        const href = String(url);
        calls.push({ url: href, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (href.endsWith('/api/v3/bytedance/avatar-omni-human-1.5')) {
          return new Response(JSON.stringify({ data: { id: 'pred-1' } }), { status: 200 });
        }
        if (href.endsWith('/api/v3/predictions/pred-1/result')) {
          return new Response(JSON.stringify({ data: { status: 'completed', outputs: ['https://ws.test/out.mp4'] } }), { status: 200 });
        }
        if (href === 'https://ws.test/out.mp4') return new Response(Buffer.from('video'), { status: 200 });
        throw new Error(`unexpected ${href}`);
      });
      const { instance, uploads } = provider(fetchImpl as unknown as typeof fetch);
      const result = await instance.generateTalkingAvatar({ id: 'g1', imageUrl: 'https://cdn.test/in/foto.jpg', audioUrl: 'https://cdn.test/in/voz.mp3' });
      expect(result).toEqual({ outputUrls: ['https://cdn.test/generations/g1/output_0.mp4'], modelUsed: 'bytedance/avatar-omni-human-1.5' });
      expect(calls[0].body).toEqual({ image: 'https://cdn.test/in/foto.jpg', audio: 'https://cdn.test/in/voz.mp3', enable_base64_output: false });
      expect(uploads.uploadBuffer).toHaveBeenCalledWith(expect.any(Buffer), 'generations/g1', 'output_0.mp4', 'video/mp4');
    });

    it('sem foto ou sem áudio não chama o provedor', async () => {
      const fetchImpl = jest.fn();
      const { instance } = provider(fetchImpl as unknown as typeof fetch);
      await expect(instance.generateTalkingAvatar({ id: 'g1', imageUrl: '', audioUrl: 'https://a' })).rejects.toThrow(/foto/);
      await expect(instance.generateTalkingAvatar({ id: 'g1', imageUrl: 'https://i', audioUrl: '' })).rejects.toThrow(/áudio/);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});
