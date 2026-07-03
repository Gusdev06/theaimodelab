import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { SubscriptionsService } from './subscriptions.service';
import { CreateSubscriptionDto } from './dto/create-subscription.dto';
import { CreatePixAutoSubscriptionDto } from './dto/create-pix-auto-subscription.dto';
import { AcceptOfferDto } from './dto/accept-offer.dto';
import { SubscriptionResponseDto } from './dto/subscription-response.dto';
import { CurrentUser } from '../common/decorators';

@ApiTags('subscriptions')
@ApiBearerAuth()
@Controller('api/v1/subscriptions')
export class SubscriptionsController {
  constructor(
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  @Get('current')
  @ApiOperation({ summary: 'Assinatura atual do usuário' })
  @ApiResponse({
    status: 200,
    description: 'Assinatura retornada com sucesso',
    type: SubscriptionResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  async getCurrent(
    @CurrentUser('sub') userId: string,
  ): Promise<SubscriptionResponseDto | null> {
    return this.subscriptionsService.getCurrentSubscription(userId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Criar assinatura (redireciona para Stripe Checkout)' })
  @ApiResponse({
    status: 201,
    description: 'URL do checkout retornada com sucesso',
  })
  @ApiResponse({ status: 400, description: 'Dados inválidos' })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  @ApiResponse({ status: 409, description: 'Já possui assinatura ativa' })
  async create(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateSubscriptionDto,
  ): Promise<{ checkoutUrl: string }> {
    return this.subscriptionsService.createSubscription(
      userId,
      dto.planSlug,
      dto.currency,
      dto.recoveryPromoCode,
    );
  }

  @Post('pix-auto')
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({
    summary: 'Criar assinatura via PIX Automático (ASAAS) — retorna QR Code de autorização',
  })
  @ApiResponse({ status: 201, description: 'Autorização criada — escaneie o QR' })
  @ApiResponse({ status: 400, description: 'CPF/CNPJ inválido ou ausente' })
  @ApiResponse({ status: 409, description: 'Já possui assinatura ativa' })
  async createPixAuto(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreatePixAutoSubscriptionDto,
  ): Promise<{
    authorizationId: string;
    qrCodePayload: string;
    qrCodeEncodedImage: string;
    expiresAt: string | null;
    status: string;
  }> {
    return this.subscriptionsService.createPixAutoSubscription(
      userId,
      dto.planSlug,
      dto.taxId,
    );
  }

  @Get('pix-auto/:authorizationId/status')
  @ApiOperation({ summary: 'Consulta status de autorização PIX Auto (polling)' })
  @ApiResponse({ status: 200, description: 'Status retornado' })
  async getPixAutoStatus(
    @CurrentUser('sub') userId: string,
    @Param('authorizationId') authorizationId: string,
  ): Promise<{ status: string; subscriptionActive: boolean }> {
    return this.subscriptionsService.getPixAutoAuthorizationStatus(
      userId,
      authorizationId,
    );
  }

  @Post('pix-auto/:authorizationId/dev-simulate-activation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      '[DEV/SANDBOX] Simula ativação da autorização sem precisar pagar o QR (só funciona em sandbox/dev)',
  })
  @ApiResponse({ status: 200, description: 'Subscription ativada' })
  @ApiResponse({ status: 400, description: 'Endpoint não disponível em prod' })
  async devSimulateActivation(
    @CurrentUser('sub') userId: string,
    @Param('authorizationId') authorizationId: string,
  ): Promise<{ activated: boolean; subscriptionId: string }> {
    return this.subscriptionsService.simulatePixAutoActivation(
      userId,
      authorizationId,
    );
  }

  @Patch('upgrade')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Upgrade de plano — sempre redireciona para Stripe Checkout' })
  @ApiResponse({
    status: 200,
    description: 'URL de checkout retornada',
  })
  @ApiResponse({ status: 400, description: 'Plano não é superior ao atual' })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  async upgrade(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateSubscriptionDto,
  ): Promise<{ checkoutUrl: string }> {
    return this.subscriptionsService.upgrade(userId, dto.planSlug, dto.currency);
  }

  @Patch('downgrade')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Downgrade de plano — agenda troca para próximo ciclo' })
  @ApiResponse({
    status: 200,
    description: 'Downgrade agendado com sucesso',
    type: SubscriptionResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Plano não é inferior ao atual' })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  @ApiResponse({ status: 404, description: 'Nenhuma assinatura ativa' })
  async downgrade(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateSubscriptionDto,
  ): Promise<SubscriptionResponseDto> {
    return this.subscriptionsService.downgrade(userId, dto.planSlug);
  }

  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancelar assinatura (acesso até fim do período)' })
  @ApiResponse({
    status: 200,
    description: 'Assinatura marcada para cancelamento',
    type: SubscriptionResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Assinatura já cancelada' })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  @ApiResponse({ status: 404, description: 'Nenhuma assinatura ativa' })
  async cancel(
    @CurrentUser('sub') userId: string,
  ): Promise<SubscriptionResponseDto> {
    return this.subscriptionsService.cancel(userId);
  }

  @Post('pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pausar assinatura por 30 dias (sem cobranca)' })
  @ApiResponse({
    status: 200,
    description: 'Assinatura pausada com sucesso',
    type: SubscriptionResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Assinatura nao pode ser pausada' })
  @ApiResponse({ status: 401, description: 'Nao autenticado' })
  @ApiResponse({ status: 404, description: 'Nenhuma assinatura ativa' })
  async pause(
    @CurrentUser('sub') userId: string,
  ): Promise<SubscriptionResponseDto> {
    return this.subscriptionsService.pause(userId);
  }

  @Post('accept-offer')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Aceitar oferta de retencao (desconto, creditos bonus, pausa)' })
  @ApiResponse({
    status: 200,
    description: 'Oferta aceita e aplicada com sucesso',
  })
  @ApiResponse({ status: 400, description: 'Oferta nao pode ser aplicada' })
  @ApiResponse({ status: 401, description: 'Nao autenticado' })
  @ApiResponse({ status: 404, description: 'Nenhuma assinatura ativa' })
  async acceptOffer(
    @CurrentUser('sub') userId: string,
    @Body() dto: AcceptOfferDto,
  ): Promise<{ offerType: string; detail: string }> {
    return this.subscriptionsService.acceptOffer(userId, dto.reason);
  }

  @Post('billing-portal')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Abre o Stripe Customer Portal para gerenciar cartoes e faturas' })
  @ApiResponse({
    status: 200,
    description: 'URL do portal retornada com sucesso',
  })
  @ApiResponse({ status: 401, description: 'Nao autenticado' })
  async billingPortal(
    @CurrentUser('sub') userId: string,
  ): Promise<{ portalUrl: string }> {
    return this.subscriptionsService.createBillingPortalSession(userId);
  }

  @Post('cancel-downgrade')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancelar downgrade agendado' })
  @ApiResponse({
    status: 200,
    description: 'Downgrade cancelado com sucesso',
    type: SubscriptionResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Nenhum downgrade agendado' })
  async cancelDowngrade(
    @CurrentUser('sub') userId: string,
  ): Promise<SubscriptionResponseDto> {
    return this.subscriptionsService.cancelDowngrade(userId);
  }

  @Post('reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reativar assinatura cancelada' })
  @ApiResponse({
    status: 200,
    description: 'Assinatura reativada com sucesso',
    type: SubscriptionResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  @ApiResponse({
    status: 404,
    description: 'Nenhuma assinatura com cancelamento pendente',
  })
  async reactivate(
    @CurrentUser('sub') userId: string,
  ): Promise<SubscriptionResponseDto> {
    return this.subscriptionsService.reactivate(userId);
  }
}
