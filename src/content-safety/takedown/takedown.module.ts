import { Module } from '@nestjs/common';
import { UploadsModule } from '../../uploads/uploads.module';
import { defaultSafetyMediaToolkit } from '../image-safety/image-safety.service';
import { CdnPurgeService } from './cdn-purge.service';
import { LegalRetentionReader } from './legal-retention';
import { TakedownPurgeCron } from './takedown-purge.cron';
import { TakedownService } from './takedown.service';
import { TAKEDOWN_MEDIA_TOOLKIT } from './takedown.tokens';

/**
 * Remoção confirmada pelo revisor (camada 8). A lista de bloqueio e a configuração da segurança de imagem vêm do
 * ImageSafetyModule (global); o storage, do UploadsModule. O SafetyReviewModule também importa este: o caso de
 * checagem confirmado com o resultado já publicado grava os itens e purga o CDN pelo mesmo TakedownService.
 */
@Module({
  imports: [UploadsModule],
  providers: [
    CdnPurgeService,
    LegalRetentionReader,
    { provide: TAKEDOWN_MEDIA_TOOLKIT, useValue: defaultSafetyMediaToolkit },
    TakedownService,
    TakedownPurgeCron,
  ],
  exports: [TakedownService],
})
export class TakedownModule {}
