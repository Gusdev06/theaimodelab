import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CommunityPostStatus } from '@prisma/client';
import { CurrentUser } from '../common/decorators';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CommunityService } from './community.service';
import {
  CreateAdminCommunityPostDto,
  RejectCommunityPostDto,
} from './dto/community.dto';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/community')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class CommunityAdminController {
  constructor(private readonly communityService: CommunityService) {}

  @Get('posts')
  @ApiOperation({ summary: 'Listar posts por status (default PENDING)' })
  async list(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const valid = ['PENDING', 'APPROVED', 'REJECTED'].includes(status ?? '')
      ? (status as CommunityPostStatus)
      : ('PENDING' as CommunityPostStatus);
    return this.communityService.adminList(
      valid,
      Math.max(1, parseInt(page ?? '1', 10) || 1),
      Math.min(60, Math.max(1, parseInt(limit ?? '30', 10) || 30)),
    );
  }

  @Post('posts')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Criar post direto na comunidade (auto-aprovado)' })
  async create(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateAdminCommunityPostDto,
  ) {
    return this.communityService.adminCreate(userId, dto);
  }

  @Post('posts/:id/approve')
  @ApiOperation({ summary: 'Aprovar post (notifica o autor)' })
  async approve(@Param('id') postId: string) {
    return this.communityService.approve(postId);
  }

  @Delete('posts/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Excluir post da comunidade' })
  async remove(@Param('id') postId: string) {
    return this.communityService.adminDelete(postId);
  }

  @Post('posts/:id/reject')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Rejeitar post (notifica o autor)' })
  async reject(
    @Param('id') postId: string,
    @Body() dto: RejectCommunityPostDto,
  ) {
    return this.communityService.reject(postId, dto.reason);
  }
}
