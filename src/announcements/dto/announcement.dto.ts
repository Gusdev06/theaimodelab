import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const VARIANTS = ['feature', 'maintenance', 'promo', 'openai', 'gift', 'mic', 'unlimited'] as const;
const ACTION_TYPES = ['open-image-panel', 'open-video-panel', 'open-audio-panel', 'open-weekly-claim', 'open-unlimited-modal', 'href'] as const;

export class CtaActionDto {
  @IsIn(ACTION_TYPES)
  type!: (typeof ACTION_TYPES)[number];

  @ValidateIf((o: CtaActionDto) => o.type === 'href')
  @IsUrl({ require_protocol: true })
  url?: string;
}

/** Campos traduzíveis de um aviso (todos opcionais — vazio cai no pt-BR base). */
export class AnnouncementLocaleDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  badge?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  ctaLabel?: string;
}

/** Traduções por locale (pt-BR é a base nos campos principais). */
export class AnnouncementTranslationsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => AnnouncementLocaleDto)
  en?: AnnouncementLocaleDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AnnouncementLocaleDto)
  es?: AnnouncementLocaleDto;
}

export class CreateAnnouncementDto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, {
    message: 'slug deve conter apenas letras minúsculas, números e hífens',
  })
  slug!: string;

  @IsOptional()
  @IsIn(VARIANTS)
  variant?: (typeof VARIANTS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(40)
  badge?: string;

  @IsString()
  @MinLength(3)
  @MaxLength(160)
  title!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(600)
  description!: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  imageUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  ctaLabel?: string;

  @IsOptional()
  ctaAction?: CtaActionDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => AnnouncementTranslationsDto)
  translations?: AnnouncementTranslationsDto;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateAnnouncementDto {
  // slug is intentionally NOT updatable — preserves localStorage seen-state stability

  @IsOptional()
  @IsIn(VARIANTS)
  variant?: (typeof VARIANTS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(40)
  badge?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(600)
  description?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  imageUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  ctaLabel?: string | null;

  @IsOptional()
  ctaAction?: CtaActionDto | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => AnnouncementTranslationsDto)
  translations?: AnnouncementTranslationsDto;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
