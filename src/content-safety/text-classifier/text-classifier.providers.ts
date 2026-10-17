import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IMAGE_SAFETY_CONFIG,
  type ImageSafetyConfig,
} from '../image-safety/image-safety.config';
import { createOmniModerationClient } from './omni-moderation.client';
import { createPolicyLoader } from './policy-loader';
import { SafeguardClient } from './safeguard.client';
import {
  createTextCacheStore,
  TextVerdictCache,
} from './text-classifier.cache';
import { TextClassifierService } from './text-classifier.service';
import {
  TEXT_CLASSIFIER_BACKENDS,
  type TextClassifierBackends,
} from './text-classifier.tokens';

/**
 * Monta os classificadores. Com o texto em off nada é criado (nenhum cliente da AWS ou da OpenAI, nenhum Redis):
 * comportamento da Onda 0. Os clientes de rede só nascem na 1ª chamada.
 */
export function createTextClassifierBackends(
  config: ImageSafetyConfig,
): TextClassifierBackends {
  const policy = createPolicyLoader(
    config.textMode === 'off' ? null : config.policySource,
  );
  if (config.textMode === 'off') {
    return { safeguard: null, shadow: [], policy };
  }
  const omni = createOmniModerationClient(config);
  return {
    safeguard: config.bedrockSafeguardModelId
      ? new SafeguardClient(config, policy)
      : null,
    shadow: omni ? [omni] : [],
    policy,
  };
}

/** Providers do classificador de texto, para o módulo de segurança de imagem registrar (junto do IMAGE_SAFETY_CONFIG). */
export const textClassifierProviders: Provider[] = [
  {
    provide: TEXT_CLASSIFIER_BACKENDS,
    inject: [IMAGE_SAFETY_CONFIG],
    useFactory: createTextClassifierBackends,
  },
  {
    provide: TextVerdictCache,
    inject: [IMAGE_SAFETY_CONFIG, ConfigService],
    useFactory: (config: ImageSafetyConfig, configService: ConfigService) =>
      new TextVerdictCache(
        createTextCacheStore(config.textMode, (key) => {
          const value = configService.get<unknown>(key);
          return typeof value === 'string' || typeof value === 'number'
            ? String(value)
            : undefined;
        }),
      ),
  },
  TextClassifierService,
];
