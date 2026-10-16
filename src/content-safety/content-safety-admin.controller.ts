import { Controller, Get, ParseIntPipe, DefaultValuePipe, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ContentSafetyEventKind } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ContentSafetyService } from './content-safety.service';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/content-safety')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class ContentSafetyAdminController {
  constructor(private readonly safety: ContentSafetyService) {}

  @Get('events')
  @ApiOperation({ summary: 'Trilha de segurança de conteúdo: recusas por menor e atestados de consentimento (admin)' })
  async events(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('kind') kind?: string,
  ) {
    if (kind && !(kind in ContentSafetyEventKind)) throw new BadRequestException('kind inválido');
    return this.safety.listForAdmin(page, limit, kind as ContentSafetyEventKind | undefined);
  }
}
