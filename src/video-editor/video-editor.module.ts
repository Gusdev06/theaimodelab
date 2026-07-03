import { Module } from '@nestjs/common';
import { VideoEditorController } from './video-editor.controller';
import { VideoEditorService } from './video-editor.service';
import { FfmpegService } from './ffmpeg.service';
import { PrismaModule } from '../prisma/prisma.module';
import { UploadsModule } from '../uploads/uploads.module';

@Module({
  imports: [PrismaModule, UploadsModule],
  controllers: [VideoEditorController],
  providers: [VideoEditorService, FfmpegService],
  exports: [VideoEditorService],
})
export class VideoEditorModule {}
