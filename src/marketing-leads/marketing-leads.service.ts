import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CaptureMarketingLeadDto } from './dto/capture-marketing-lead.dto';

type StoredMarketingLead = {
  id: string;
  captured: true;
};

@Injectable()
export class MarketingLeadsService {
  constructor(private readonly prisma: PrismaService) {}

  async capture(dto: CaptureMarketingLeadDto): Promise<StoredMarketingLead> {
    const email = dto.email.trim().toLowerCase();
    const source = this.normalizeSource(dto.source);
    const data = this.buildLeadData(dto, email, source);

    const lead = await this.prisma.marketingLead.upsert({
      where: {
        email_source: {
          email,
          source,
        },
      },
      create: data,
      update: data,
      select: { id: true },
    });

    return { id: lead.id, captured: true };
  }

  private normalizeSource(source?: string): string {
    const normalized = (source ?? 'sales_quiz')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);

    return normalized || 'sales_quiz';
  }

  private buildLeadData(
    dto: CaptureMarketingLeadDto,
    email: string,
    source: string,
  ): Prisma.MarketingLeadUncheckedCreateInput {
    const attribution = this.compactObject({
      utmSource: dto.utmSource,
      utmMedium: dto.utmMedium,
      utmCampaign: dto.utmCampaign,
      utmContent: dto.utmContent,
      utmTerm: dto.utmTerm,
      fbclid: dto.fbclid,
      fbp: dto.fbp,
      fbc: dto.fbc,
      gclid: dto.gclid,
      landingPage: dto.landingPage,
      referrer: dto.referrer,
      eventId: dto.eventId,
      eventSourceUrl: dto.eventSourceUrl,
      ...(dto.attribution ?? {}),
    });

    return {
      email,
      source,
      name: this.cleanOptionalString(dto.name),
      phone: this.cleanOptionalString(dto.phone),
      quizResult: this.cleanOptionalString(dto.quizResult),
      quizAnswers: dto.quizAnswers as Prisma.InputJsonValue | undefined,
      attribution: attribution as Prisma.InputJsonValue | undefined,
      utmSource: this.cleanOptionalString(dto.utmSource),
      utmMedium: this.cleanOptionalString(dto.utmMedium),
      utmCampaign: this.cleanOptionalString(dto.utmCampaign),
      utmContent: this.cleanOptionalString(dto.utmContent),
      utmTerm: this.cleanOptionalString(dto.utmTerm),
      fbclid: this.cleanOptionalString(dto.fbclid),
      fbp: this.cleanOptionalString(dto.fbp),
      fbc: this.cleanOptionalString(dto.fbc),
      gclid: this.cleanOptionalString(dto.gclid),
      landingPage: this.cleanOptionalString(dto.landingPage ?? dto.eventSourceUrl),
      referrer: this.cleanOptionalString(dto.referrer),
      eventId: this.cleanOptionalString(dto.eventId),
    };
  }

  private cleanOptionalString(value?: string): string | undefined {
    const trimmed = value?.trim();
    return trimmed || undefined;
  }

  private compactObject(value: Record<string, unknown>): Record<string, unknown> | undefined {
    const entries = Object.entries(value).filter(([, entryValue]) => {
      if (entryValue === null || entryValue === undefined) return false;
      if (typeof entryValue === 'string') return entryValue.trim().length > 0;
      return true;
    });

    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
}
