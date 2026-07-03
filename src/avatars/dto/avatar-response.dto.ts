import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AvatarConsentStatus, AvatarStatus } from '@prisma/client';

export class AvatarResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: AvatarStatus }) status: AvatarStatus;
  @ApiProperty({ enum: AvatarConsentStatus }) consentStatus: AvatarConsentStatus;

  @ApiPropertyOptional() previewImageUrl: string | null;
  @ApiPropertyOptional() previewVideoUrl: string | null;
  @ApiPropertyOptional() defaultVoiceId: string | null;
  @ApiPropertyOptional({ type: [String] }) supportedEngines: string[];

  @ApiPropertyOptional() consentUrl: string | null;
  @ApiPropertyOptional() consentApprovedAt: Date | null;

  @ApiPropertyOptional() errorMessage: string | null;
  @ApiPropertyOptional() errorCode: string | null;

  @ApiProperty() creditsConsumed: number;

  @ApiPropertyOptional() trainingStartedAt: Date | null;
  @ApiPropertyOptional() trainingCompletedAt: Date | null;
  @ApiProperty() createdAt: Date;
}

export class AvatarQuotaDto {
  @ApiProperty() used: number;
  @ApiProperty() limit: number;
  @ApiProperty() enabled: boolean;
  @ApiProperty() planSlug: string;
}

export class AvatarListResponseDto {
  @ApiProperty({ type: [AvatarResponseDto] }) avatars: AvatarResponseDto[];
  @ApiProperty({ type: AvatarQuotaDto }) quota: AvatarQuotaDto;
}
