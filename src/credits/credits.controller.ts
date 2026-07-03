import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { CreditsService } from './credits.service';
import { CurrentUser } from '../common/decorators';
import { PaginationDto } from '../common/dto/pagination.dto';
import { CreditBalanceResponseDto } from './dto/credit-balance-response.dto';
import { CreditTransactionResponseDto } from './dto/credit-transaction-response.dto';
import { EstimateCostDto, EstimateCostResponseDto } from './dto/estimate-cost.dto';
import { PurchaseCreditsDto } from './dto/purchase-credits.dto';
import { PaginatedResponseDto } from '../common/dto/paginated-response.dto';
import { PlansService } from '../plans/plans.service';
import { StripeService } from '../payments/stripe.service';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('credits')
@ApiBearerAuth()
@Controller('api/v1/credits')
export class CreditsController {
  constructor(
    private readonly creditsService: CreditsService,
    private readonly plansService: PlansService,
    private readonly stripeService: StripeService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('balance')
  @ApiOperation({ summary: 'Saldo detalhado de créditos (plan + bonus)' })
  @ApiResponse({
    status: 200,
    description: 'Saldo retornado com sucesso',
    type: CreditBalanceResponseDto,
  })
  async getBalance(
    @CurrentUser('sub') userId: string,
  ): Promise<CreditBalanceResponseDto> {
    return this.creditsService.getBalance(userId);
  }

  @Get('transactions')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Histórico de transações de créditos (paginado)' })
  @ApiResponse({
    status: 200,
    description: 'Transações retornadas com sucesso',
  })
  async getTransactions(
    @CurrentUser('sub') userId: string,
    @Query() pagination: PaginationDto,
  ): Promise<PaginatedResponseDto<CreditTransactionResponseDto>> {
    return this.creditsService.getTransactions(userId, pagination);
  }

  @Get('packages')
  @ApiOperation({ summary: 'Lista pacotes de créditos disponíveis' })
  async getPackages(
    @CurrentUser('sub') userId: string,
    @Query('currency') currencyQuery?: string,
  ) {
    let resolvedCurrency = currencyQuery?.toUpperCase();
    if (!resolvedCurrency) {
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { currency: true },
      });
      resolvedCurrency = user.currency;
    }
    const packages = await this.creditsService.getPackages();
    return Promise.all(
      packages.map(async (pkg) => {
        let priceCents = pkg.priceCents;
        let currency = 'BRL';
        try {
          const resolved = await this.plansService.resolvePackagePrice(pkg.id, resolvedCurrency!);
          priceCents = resolved.priceCents;
          currency = resolved.currency;
        } catch {}
        return {
          id: pkg.id,
          name: pkg.name,
          credits: pkg.credits,
          priceCents,
          currency,
          isActive: pkg.isActive,
          sortOrder: pkg.sortOrder,
          stripePriceId: pkg.stripePriceId,
          createdAt: pkg.createdAt,
        };
      }),
    );
  }

  @Post('purchase')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Compra pacote de créditos (redireciona para Stripe Checkout)' })
  @ApiResponse({
    status: 200,
    description: 'URL do checkout retornada com sucesso',
  })
  async purchaseCredits(
    @CurrentUser('sub') userId: string,
    @Body() dto: PurchaseCreditsDto,
  ): Promise<{ checkoutUrl: string }> {
    const pkg = await this.plansService.findPackageById(dto.packageId);

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, name: true, referredByCode: true, currency: true },
    });

    const currency = dto.currency ?? user.currency;
    const resolved = await this.plansService.resolvePackagePrice(pkg.id, currency);

    const customerId = await this.stripeService.getOrCreateCustomer(
      userId,
      user.email,
      user.name,
    );

    const checkoutUrl = await this.stripeService.createCreditPurchaseCheckout(
      customerId,
      pkg.id,
      pkg.name,
      pkg.credits,
      resolved.priceCents,
      userId,
      resolved.stripePriceId,
      user.referredByCode ?? undefined,
    );

    return { checkoutUrl };
  }

  @Post('estimate')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Calcula custo de uma geração antes de executar' })
  @ApiResponse({
    status: 200,
    description: 'Estimativa calculada com sucesso',
    type: EstimateCostResponseDto,
  })
  async estimateCost(
    @CurrentUser('sub') userId: string,
    @Body() dto: EstimateCostDto,
  ): Promise<EstimateCostResponseDto> {
    return this.creditsService.estimateCost(
      userId,
      dto.type,
      dto.resolution,
      dto.durationSeconds,
      dto.hasAudio,
      dto.sampleCount,
      dto.modelVariant,
      dto.freeGenerationType,
      dto.hasVideoInput,
    );
  }
}
