import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import {
  AcceptLanguageResolver,
  HeaderResolver,
  I18nModule,
  QueryResolver,
} from 'nestjs-i18n';
import * as path from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { PlansModule } from './plans/plans.module';
import { UsersModule } from './users/users.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { CustomThrottlerGuard } from './common/guards/throttle.guard';
import { UploadsModule } from './uploads/uploads.module';
import { WebhookLogsModule } from './webhook-logs/webhook-logs.module';
import { CreditsModule } from './credits/credits.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { AdminModule } from './admin/admin.module';
import { CronModule } from './cron/cron.module';
import { PaymentsModule } from './payments/payments.module';
import { GenerationsModule } from './generations/generations.module';
import { GalleryModule } from './gallery/gallery.module';
import { FoldersModule } from './folders/folders.module';
import { VideoEditorModule } from './video-editor/video-editor.module';
import { PromptEnhancerModule } from './prompt-enhancer/prompt-enhancer.module';
import { PromptAgentModule } from './prompt-agent/prompt-agent.module';
import { AffiliatesModule } from './affiliates/affiliates.module';
import { PromptsModule } from './prompts/prompts.module';
import { PromptPostsModule } from './prompt-posts/prompt-posts.module';
import { ModelsModule } from './models/models.module';
import { PendingGrantsModule } from './pending-grants/pending-grants.module';
import { FeedbackModule } from './feedback/feedback.module';
import { RewardsModule } from './rewards/rewards.module';
import { AnnouncementsModule } from './announcements/announcements.module';
import { VoicesModule } from './voices/voices.module';
import { InworldVoicesModule } from './inworld-voices/inworld-voices.module';
import { AdminEmailsModule } from './admin-emails/admin-emails.module';
import { ResendWebhooksModule } from './resend-webhooks/resend-webhooks.module';
import { AvatarsModule } from './avatars/avatars.module';
import { UnlimitedModule } from './unlimited/unlimited.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { CommunityModule } from './community/community.module';
import { NotificationsModule } from './notifications/notifications.module';
import { parseRedisConfig } from './common/redis-config';


@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const { host, port, password, username, db } = parseRedisConfig(
          config.getOrThrow<string>('REDIS_URL'),
          config.get<string>('REDIS_DB'),
        );
        return {
          connection: { host, port, password, username, db },
        };
      },
    }),
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'default',
          ttl: 60000,
          limit: 30,
        },
      ],
    }),
    I18nModule.forRoot({
      fallbackLanguage: 'pt-BR',
      fallbacks: {
        'en-*': 'en',
        'pt-*': 'pt-BR',
        'es-*': 'es',
      },
      loaderOptions: {
        path: path.join(__dirname, '/i18n/'),
        watch: process.env.NODE_ENV !== 'production',
      },
      resolvers: [
        new QueryResolver(['lang', 'locale']),
        new HeaderResolver(['x-lang']),
        AcceptLanguageResolver,
      ],
      typesOutputPath: path.join(process.cwd(), 'src/generated/i18n.generated.ts'),
    }),
    PrismaModule,
    AuthModule,
    PlansModule,
    UsersModule,
    UploadsModule,
    WebhookLogsModule,
    CreditsModule,
    SubscriptionsModule,
    AdminModule,
    CronModule,
    PaymentsModule,
    GenerationsModule,
    GalleryModule,
    PromptsModule,
    PromptPostsModule,
    FoldersModule,
    VideoEditorModule,
    PromptEnhancerModule,
    PromptAgentModule,
    AffiliatesModule,
    ModelsModule,
    PendingGrantsModule,
    FeedbackModule,
    RewardsModule,
    AnnouncementsModule,
    VoicesModule,
    InworldVoicesModule,
    WorkspacesModule,
    CommunityModule,
    NotificationsModule,
    AdminEmailsModule,
    ResendWebhooksModule,
    AvatarsModule,
    UnlimitedModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: CustomThrottlerGuard,
    },
  ],
})
export class AppModule { }
