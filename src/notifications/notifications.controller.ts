import { Controller, Delete, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('api/v1/notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Listar notificacoes do usuario + nao lidas' })
  @ApiResponse({ status: 200, description: 'Notificacoes retornadas' })
  async list(@CurrentUser('sub') userId: string) {
    return this.notificationsService.list(userId);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marcar todas as notificacoes como lidas' })
  @ApiResponse({ status: 200, description: 'Notificacoes marcadas como lidas' })
  async readAll(@CurrentUser('sub') userId: string) {
    return this.notificationsService.readAll(userId);
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remover todas as notificacoes do usuario' })
  @ApiResponse({ status: 200, description: 'Notificacoes removidas' })
  async clearAll(@CurrentUser('sub') userId: string) {
    return this.notificationsService.clearAll(userId);
  }
}
