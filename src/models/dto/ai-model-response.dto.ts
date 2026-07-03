import { ApiProperty } from '@nestjs/swagger';
import { AiModelProvider } from '@prisma/client';

export class AiModelResponseDto {
  @ApiProperty()
  slug!: string;

  @ApiProperty()
  label!: string;

  @ApiProperty({ nullable: true })
  description!: string | null;

  @ApiProperty({ enum: ['THEAIMODELAB', 'KIE'] })
  provider!: AiModelProvider;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty({ nullable: true })
  statusMessage!: string | null;

  @ApiProperty()
  sortOrder!: number;

  /**
   * True for "gateway" entries (feature flags managed via the admin page) that
   * shouldn't appear as selectable models in the generation panels. The
   * frontend filters these out of dropdowns but still uses them to gate the
   * corresponding feature (e.g. avatar video, motion control).
   */
  @ApiProperty()
  isGateway!: boolean;
}
