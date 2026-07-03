import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Brand } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { BrandReferenceInputDto, CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import { BrandResponseDto } from './dto/brand-response.dto';
import {
  BrandIdentity,
  VisualAnalyzerService,
} from './visual-analyzer.service';

interface StoredReferenceAsset {
  url: string;
  type: string;
  analysis?: {
    observations: string;
    key_elements: string[];
  };
}

@Injectable()
export class BrandsService {
  private readonly logger = new Logger(BrandsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly visualAnalyzer: VisualAnalyzerService,
  ) {}

  async create(userId: string, dto: CreateBrandDto): Promise<BrandResponseDto> {
    const references = dto.references ?? [];
    const { identityProfile, referenceAssets } =
      references.length > 0
        ? await this.runAnalysis(references)
        : { identityProfile: null, referenceAssets: [] as StoredReferenceAsset[] };

    const brand = await this.prisma.brand.create({
      data: {
        userId,
        name: dto.name,
        identityProfile: (identityProfile ?? undefined) as any,
        referenceAssets: referenceAssets as any,
      },
    });

    return this.toDto(brand);
  }

  async findAll(
    userId: string,
    pagination: PaginationDto,
  ): Promise<PaginatedResponseDto<BrandResponseDto>> {
    const where = { userId, isDeleted: false };

    const [brands, total] = await Promise.all([
      this.prisma.brand.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      this.prisma.brand.count({ where }),
    ]);

    return new PaginatedResponseDto(
      brands.map((b) => this.toDto(b)),
      total,
      pagination.page,
      pagination.limit,
    );
  }

  async findOne(userId: string, brandId: string): Promise<BrandResponseDto> {
    const brand = await this.ensureOwned(userId, brandId);
    return this.toDto(brand);
  }

  async update(
    userId: string,
    brandId: string,
    dto: UpdateBrandDto,
  ): Promise<BrandResponseDto> {
    await this.ensureOwned(userId, brandId);

    const referencesChanged = dto.references !== undefined;
    let identityProfileUpdate: BrandIdentity | null | undefined = undefined;
    let referenceAssetsUpdate: StoredReferenceAsset[] | undefined = undefined;

    if (referencesChanged) {
      if (dto.references!.length === 0) {
        identityProfileUpdate = null;
        referenceAssetsUpdate = [];
      } else {
        const result = await this.runAnalysis(dto.references!);
        identityProfileUpdate = result.identityProfile;
        referenceAssetsUpdate = result.referenceAssets;
      }
    }

    const updated = await this.prisma.brand.update({
      where: { id: brandId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(referencesChanged && {
          identityProfile: identityProfileUpdate as any,
          referenceAssets: (referenceAssetsUpdate ?? []) as any,
        }),
      },
    });

    return this.toDto(updated);
  }

  async remove(userId: string, brandId: string): Promise<void> {
    await this.ensureOwned(userId, brandId);
    await this.prisma.brand.update({
      where: { id: brandId },
      data: { isDeleted: true },
    });
  }

  private async ensureOwned(userId: string, brandId: string): Promise<Brand> {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
    });
    if (!brand || brand.isDeleted) {
      throw new NotFoundException('Marca nao encontrada');
    }
    if (brand.userId !== userId) {
      throw new ForbiddenException('Acesso negado');
    }
    return brand;
  }

  private async runAnalysis(refs: BrandReferenceInputDto[]): Promise<{
    identityProfile: BrandIdentity;
    referenceAssets: StoredReferenceAsset[];
  }> {
    const urls = refs.map((r) => r.url);
    const analysis = await this.visualAnalyzer.analyze(urls);

    const assetsByUrl = new Map(analysis.assets.map((a) => [a.url, a]));

    const referenceAssets: StoredReferenceAsset[] = refs.map((r) => {
      const a = assetsByUrl.get(r.url);
      return {
        url: r.url,
        type: r.type,
        analysis: a
          ? {
              observations: a.observations,
              key_elements: a.key_elements,
            }
          : undefined,
      };
    });

    return {
      identityProfile: analysis.brand_identity,
      referenceAssets,
    };
  }

  private toDto(brand: Brand): BrandResponseDto {
    return {
      id: brand.id,
      name: brand.name,
      identityProfile:
        (brand.identityProfile as Record<string, unknown>) ?? null,
      referenceAssets:
        (brand.referenceAssets as unknown as Array<{
          url: string;
          type: string;
          analysis?: Record<string, unknown>;
        }>) ?? [],
      createdAt: brand.createdAt,
      updatedAt: brand.updatedAt,
    };
  }
}
