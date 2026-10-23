import { Global, Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { UploadsModule } from '../../uploads/uploads.module';
import { ActiveUserInvalidationBus } from '../strikes/active-user-invalidation';
import { StrikesService } from '../strikes/strikes.service';
import { STRIKES, SUSPENSION_EFFECTS } from '../strikes/strikes.types';
import { createSuspensionEffects } from '../strikes/suspension-effects';
import { textClassifierProviders } from '../text-classifier/text-classifier.providers';
import { TextClassifierService } from '../text-classifier/text-classifier.service';
import { BlocklistService } from './blocklist.service';
import {
  IMAGE_SAFETY_CONFIG,
  imageSafetyConfigProvider,
  type ImageSafetyConfig,
} from './image-safety.config';
import {
  defaultSafetyMediaToolkit,
  ImageSafetyService,
} from './image-safety.service';
import {
  BLOCKLIST,
  IMAGE_SCANNER,
  KNOWN_HASH_MATCHER,
  PREFLIGHT_STATUS_READER,
  SAFETY_MEDIA_TOOLKIT,
  STYLIZED_JUDGE,
} from './image-safety.tokens';
import { createKnownHashMatcher } from './known-csam.matcher';
import { createPreflightStatusReader } from './preflight-status.reader';
import { QuarantineCron } from './quarantine.cron';
import { RekognitionScanner } from './rekognition.scanner';
import { ScanRetentionCron } from './scan-retention';
import { createStylizedJudge } from './stylized-judge.client';

/**
 * Segurança de imagem e texto (camadas 2, 3 e 5). Global de propósito: o processor da fila, o ContentSafetyService
 * (status do preflight) e o UploadsService (quarentena) leem daqui sem cada módulo importar este.
 * Com IMAGE_SAFETY_MODE=off o leitor de imagem nem é construído (nenhum cliente da AWS); com TEXT_CLASSIFIER_MODE=off
 * os classificadores de texto também não (text-classifier.providers).
 */
@Global()
@Module({
  imports: [UploadsModule],
  providers: [
    imageSafetyConfigProvider,
    BlocklistService,
    { provide: BLOCKLIST, useExisting: BlocklistService },
    {
      provide: IMAGE_SCANNER,
      inject: [IMAGE_SAFETY_CONFIG],
      useFactory: (config: ImageSafetyConfig) =>
        config.imageMode === 'off' ? null : new RekognitionScanner(config),
    },
    {
      provide: KNOWN_HASH_MATCHER,
      inject: [IMAGE_SAFETY_CONFIG],
      useFactory: (config: ImageSafetyConfig) => createKnownHashMatcher(config),
    },
    {
      provide: STYLIZED_JUDGE,
      inject: [IMAGE_SAFETY_CONFIG],
      useFactory: (config: ImageSafetyConfig) => createStylizedJudge(config),
    },
    { provide: SAFETY_MEDIA_TOOLKIT, useValue: defaultSafetyMediaToolkit },
    {
      provide: PREFLIGHT_STATUS_READER,
      inject: [PrismaService, IMAGE_SAFETY_CONFIG],
      useFactory: createPreflightStatusReader,
    },
    ...textClassifierProviders,
    // camada 6: pontos e suspensão (efeitos na fila, no processor e no e-mail buscados na hora pelo ModuleRef)
    {
      provide: SUSPENSION_EFFECTS,
      inject: [ModuleRef],
      useFactory: createSuspensionEffects,
    },
    StrikesService,
    { provide: STRIKES, useExisting: StrikesService },
    ActiveUserInvalidationBus,
    ImageSafetyService,
    QuarantineCron,
    ScanRetentionCron,
  ],
  exports: [
    IMAGE_SAFETY_CONFIG,
    PREFLIGHT_STATUS_READER,
    ImageSafetyService,
    TextClassifierService,
    BlocklistService,
    BLOCKLIST,
    StrikesService,
    STRIKES,
  ],
})
export class ImageSafetyModule {}
