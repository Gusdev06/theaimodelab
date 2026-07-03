import {
  Controller,
  Post,
  Get,
  Body,
  BadRequestException,
  Headers,
  Param,
  HttpCode,
  HttpStatus,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { CurrentUser, Public } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { PlansService } from '../plans/plans.service';
import { AsaasService } from './asaas.service';
import { AsaasWebhookService } from './webhooks/asaas-webhook.service';
import { CreatePixBoostDto } from './dto/create-pix-boost.dto';
import { PixResponseDto } from './dto/pix-response.dto';

@ApiTags('asaas')
@Controller('api/v1')
export class AsaasController {
  constructor(
    private readonly asaasService: AsaasService,
    private readonly asaasWebhookService: AsaasWebhookService,
    private readonly plansService: PlansService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('payments/pix/boost')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Cria um PIX QR Code para compra de pacote de créditos (via ASAAS)' })
  @ApiResponse({ status: 201, type: PixResponseDto })
  async createBoostPix(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreatePixBoostDto,
  ): Promise<PixResponseDto> {
    const pkg = await this.plansService.findPackageById(dto.packageId);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        email: true,
        name: true,
        referredByCode: true,
        asaasCustomerId: true,
        taxId: true,
      },
    });

    const price = await this.plansService.resolvePackagePrice(pkg.id, 'BRL');

    // Prefere CPF/CNPJ do body (user pode estar trocando) e cai pro salvo.
    // Sem nenhum dos dois → primeira compra → exige.
    const cpfCnpj = dto.taxId ?? user.taxId;
    if (!cpfCnpj) {
      throw new BadRequestException('CPF ou CNPJ é obrigatório na primeira compra via PIX.');
    }

    const customerId = await this.asaasService.getOrCreateCustomer(
      userId,
      user.name,
      user.email,
      cpfCnpj!,
    );

    const pix = await this.asaasService.createPixCharge({
      customerId,
      amountCents: price.priceCents,
      description: `Boost — ${pkg.name}`,
      externalReference: JSON.stringify({
        userId,
        packageId: pkg.id,
        ...(user.referredByCode ? { referredByCode: user.referredByCode } : {}),
      }),
    });

    return {
      paymentId: pix.id,
      amountCents: pix.amountCents,
      status: pix.status,
      brCode: pix.brCode,
      brCodeBase64: pix.brCodeBase64,
      expiresAt: pix.expiresAt,
      devMode: this.asaasService.isSandbox(),
    };
  }

  @Get('payments/pix/:id/status')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Consulta status de um PIX (para polling no frontend)' })
  @ApiResponse({ status: 200, description: 'Status do PIX' })
  async getPixStatus(
    @Param('id') id: string,
  ): Promise<{ status: string; paid: boolean }> {
    const result = await this.asaasService.checkPaymentStatus(id);
    return { status: result.status, paid: result.status === 'PAID' };
  }

  @Public()
  @Post('webhooks/asaas')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Webhook do ASAAS (autenticado via header asaas-access-token)' })
  @ApiResponse({ status: 200, description: 'Webhook processado' })
  @ApiResponse({ status: 401, description: 'asaas-access-token inválido' })
  async webhook(
    @Headers('asaas-access-token') accessToken: string | undefined,
    @Body() payload: Record<string, unknown>,
  ): Promise<{ received: true }> {
    await this.asaasWebhookService.handleWebhook(accessToken, payload);
    return { received: true };
  }
}
