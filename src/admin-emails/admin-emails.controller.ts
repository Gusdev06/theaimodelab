import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../common/decorators/current-user.decorator';
import { AdminEmailsService } from './admin-emails.service';
import { CreateBroadcastDto } from './dto/create-broadcast.dto';
import { RecipientSelectionDto } from './dto/recipient-filter.dto';
import { SendTestDto } from './dto/send-test.dto';

@ApiTags('admin-emails')
@ApiBearerAuth()
@Controller('api/v1/admin/emails')
@UseGuards(RolesGuard)
@Roles('ADMIN')
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class AdminEmailsController {
  constructor(private readonly adminEmails: AdminEmailsService) {}

  // ─── Preview da contagem antes de disparar ────────────────────
  @Post('preview-count')
  @ApiOperation({
    summary: 'Calcula quantos destinatários o filtro atinge (sem enviar nada)',
  })
  @ApiResponse({ status: 200, schema: { example: { count: 134 } } })
  async previewCount(@Body() dto: RecipientSelectionDto) {
    return this.adminEmails.previewRecipientCount(dto.recipientType, dto.recipientFilter);
  }

  // ─── Renderiza HTML pra preview do front ──────────────────────
  @Post('render-preview')
  @ApiOperation({ summary: 'Renderiza markdown → HTML final + aplica merge tags' })
  async renderPreview(
    @Body()
    body: {
      bodyMarkdown: string;
      subject?: string;
      mergeVars?: Record<string, string>;
      format?: 'markdown' | 'html';
    },
  ) {
    return this.adminEmails.renderPreview({
      bodyMarkdown: body.bodyMarkdown ?? '',
      subject: body.subject,
      mergeVars: body.mergeVars,
      format: body.format,
    });
  }

  // ─── Envia email de teste pro próprio admin ───────────────────
  @Post('test')
  @ApiOperation({ summary: 'Envia o email de teste pro próprio admin logado' })
  async sendTest(@CurrentUser() user: JwtPayload, @Body() dto: SendTestDto) {
    await this.adminEmails.sendTest({
      triggeredByUserId: user.sub,
      triggeredByEmail: user.email,
      subject: dto.subject,
      bodyMarkdown: dto.bodyMarkdown,
      format: dto.format,
    });
    return { ok: true, sentTo: user.email };
  }

  // ─── Cria + dispara o broadcast (assíncrono via BullMQ) ───────
  @Post('send')
  @ApiOperation({ summary: 'Cria broadcast e enfileira pra disparo assíncrono' })
  async send(@CurrentUser() user: JwtPayload, @Body() dto: CreateBroadcastDto) {
    const broadcast = await this.adminEmails.createAndDispatch({
      triggeredByUserId: user.sub,
      subject: dto.subject,
      bodyMarkdown: dto.bodyMarkdown,
      recipientType: dto.recipientType,
      recipientFilter: dto.recipientFilter,
      format: dto.format,
    });
    return {
      id: broadcast.id,
      status: broadcast.status,
      totalRecipients: broadcast.totalRecipients,
    };
  }

  // ─── Histórico ────────────────────────────────────────────────
  @Get()
  @ApiOperation({ summary: 'Lista de broadcasts (mais recentes primeiro)' })
  async list(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.adminEmails.listBroadcasts(page, Math.min(limit, 100));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalhes de um broadcast (até 200 destinatários)' })
  async detail(@Param('id') id: string) {
    return this.adminEmails.getBroadcast(id);
  }
}
