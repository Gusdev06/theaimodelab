import { ApiProperty } from '@nestjs/swagger';

export class VoiceResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  language: string;

  @ApiProperty()
  status: string;

  @ApiProperty()
  sampleUrl: string;

  @ApiProperty({ nullable: true, required: false })
  previewUrl: string | null;

  @ApiProperty({ nullable: true, required: false })
  previewText: string | null;

  @ApiProperty()
  createdAt: Date;
}

export class VoiceQuotaResponseDto {
  @ApiProperty({ description: 'Vozes salvas atualmente' })
  used: number;

  @ApiProperty({ description: 'Limite do plano atual' })
  limit: number;

  @ApiProperty({ description: 'Slug do plano atual' })
  planSlug: string;
}

export class VoiceListResponseDto {
  @ApiProperty({ type: [VoiceResponseDto] })
  voices: VoiceResponseDto[];

  @ApiProperty({ type: VoiceQuotaResponseDto })
  quota: VoiceQuotaResponseDto;
}
