import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { UploadsService } from '../uploads/uploads.service';
import { CronLoggerService } from './cron-logger.service';

const SCHEDULE = '0 3 * * *';

@Injectable()
export class GalleryCleanupService {
  private readonly logger = new Logger(GalleryCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadsService: UploadsService,
    private readonly cronLogger: CronLoggerService,
  ) {}

  @Cron(SCHEDULE)
  async handleGalleryCleanup() {
    try {
      return await this.cronLogger.wrap(
        { cronName: 'GalleryCleanupService.handleGalleryCleanup', schedule: SCHEDULE },
        async () => {
          const now = new Date();

          const expiredGenerations = await this.prisma.generation.findMany({
            where: {
              expiresAt: { lte: now },
              isDeleted: false,
            },
            select: {
              id: true,
              outputs: { select: { url: true, thumbnailUrl: true } },
            },
            take: 200,
          });

          if (expiredGenerations.length === 0) {
            return { expiredFound: 0 };
          }

          await this.prisma.generation.updateMany({
            where: { id: { in: expiredGenerations.map((g) => g.id) } },
            data: { isDeleted: true },
          });

          this.logger.log(`Marked ${expiredGenerations.length} expired generations as deleted`);

          for (const gen of expiredGenerations) {
            this.deleteGenerationFiles(gen.id).catch((err) => {
              this.logger.warn(
                `Failed to delete S3 files for generation ${gen.id}: ${(err as Error).message}`,
              );
            });
          }

          return { expiredFound: expiredGenerations.length };
        },
      );
    } catch (error: any) {
      this.logger.error(`Gallery cleanup cron failed: ${error.message}`, error.stack);
    }
  }

  private async deleteGenerationFiles(generationId: string): Promise<void> {
    const [outputsDeleted, thumbnailsDeleted] = await Promise.all([
      this.uploadsService.deleteByPrefix(`outputs/${generationId}/`),
      this.uploadsService.deleteByPrefix(`thumbnails/${generationId}/`),
    ]);

    if (outputsDeleted + thumbnailsDeleted > 0) {
      this.logger.log(
        `Deleted ${outputsDeleted + thumbnailsDeleted} S3 file(s) for expired generation ${generationId}`,
      );
    }
  }
}
