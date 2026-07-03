import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminStripeService } from './admin-stripe.service';
import {
  ChargeListQueryDto,
  CustomerListQueryDto,
  InvoiceListQueryDto,
  ListQueryDto,
  PriceListQueryDto,
  ProductListQueryDto,
  PromotionCodeListQueryDto,
  SubscriptionListQueryDto,
} from './dto/list-query.dto';
import {
  CancelSubscriptionDto,
  CreateCouponDto,
  CreatePriceDto,
  CreateProductDto,
  CreatePromotionCodeDto,
  RefundChargeDto,
  TogglePromotionCodeDto,
  UpdateProductDto,
} from './dto/mutations.dto';
import type Stripe from 'stripe';

@ApiTags('admin/stripe')
@ApiBearerAuth()
@Controller('api/v1/admin/stripe')
@UseGuards(RolesGuard)
@Roles('ADMIN')
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class AdminStripeController {
  constructor(private readonly stripe: AdminStripeService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Resumo (saldo + contagem de subscriptions por status)' })
  overview() {
    return this.stripe.getOverview();
  }

  // ===== CHARGES (transações) =====

  @Get('charges')
  @ApiOperation({ summary: 'Lista transações (charges)' })
  listCharges(@Query() q: ChargeListQueryDto) {
    return this.stripe.listCharges({
      limit: q.limit,
      startingAfter: q.starting_after,
      endingBefore: q.ending_before,
      customer: q.customer,
    });
  }

  @Get('charges/:id')
  getCharge(@Param('id') id: string) {
    return this.stripe.getCharge(id);
  }

  @Post('charges/:id/refund')
  refundCharge(@Param('id') id: string, @Body() dto: RefundChargeDto) {
    return this.stripe.refundCharge(id, dto.amount, dto.reason);
  }

  // ===== CUSTOMERS =====

  @Get('customers')
  @ApiOperation({ summary: 'Lista clientes (filtro por email ou Stripe search)' })
  async listCustomers(@Query() q: CustomerListQueryDto) {
    if (q.search) {
      return this.stripe.searchCustomers(q.search, q.limit);
    }
    return this.stripe.listCustomers({
      limit: q.limit,
      startingAfter: q.starting_after,
      endingBefore: q.ending_before,
      email: q.email,
    });
  }

  @Get('customers/:id')
  @ApiOperation({ summary: 'Detalhe do cliente + subs/charges/invoices/payment methods' })
  getCustomer(@Param('id') id: string) {
    return this.stripe.getCustomer(id);
  }

  // ===== PRODUCTS =====

  @Get('products')
  listProducts(@Query() q: ProductListQueryDto) {
    return this.stripe.listProducts({
      limit: q.limit,
      startingAfter: q.starting_after,
      endingBefore: q.ending_before,
      active: q.active,
    });
  }

  @Get('products/:id')
  getProduct(@Param('id') id: string) {
    return this.stripe.getProduct(id);
  }

  @Post('products')
  createProduct(@Body() dto: CreateProductDto) {
    return this.stripe.createProduct(dto);
  }

  @Patch('products/:id')
  updateProduct(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.stripe.updateProduct(id, dto);
  }

  @Delete('products/:id')
  @ApiOperation({ summary: 'Deleta (ou arquiva automaticamente se houver prices)' })
  async deleteProduct(@Param('id') id: string) {
    try {
      return await this.stripe.deleteProduct(id);
    } catch {
      return this.stripe.archiveProduct(id);
    }
  }

  // ===== PRICES =====

  @Get('prices')
  listPrices(@Query() q: PriceListQueryDto) {
    return this.stripe.listPrices({
      limit: q.limit,
      startingAfter: q.starting_after,
      endingBefore: q.ending_before,
      product: q.product,
      active: q.active,
    });
  }

  @Get('prices/:id')
  getPrice(@Param('id') id: string) {
    return this.stripe.getPrice(id);
  }

  @Post('prices')
  createPrice(@Body() dto: CreatePriceDto) {
    return this.stripe.createPrice(dto);
  }

  @Patch('prices/:id/archive')
  archivePrice(@Param('id') id: string) {
    return this.stripe.archivePrice(id);
  }

  @Patch('prices/:id/activate')
  activatePrice(@Param('id') id: string) {
    return this.stripe.activatePrice(id);
  }

  // ===== COUPONS =====

  @Get('coupons')
  listCoupons(@Query() q: ListQueryDto) {
    return this.stripe.listCoupons({
      limit: q.limit,
      startingAfter: q.starting_after,
      endingBefore: q.ending_before,
    });
  }

  @Get('coupons/:id')
  getCoupon(@Param('id') id: string) {
    return this.stripe.getCoupon(id);
  }

  @Post('coupons')
  createCoupon(@Body() dto: CreateCouponDto) {
    return this.stripe.createCoupon(dto);
  }

  @Delete('coupons/:id')
  deleteCoupon(@Param('id') id: string) {
    return this.stripe.deleteCoupon(id);
  }

  // ===== PROMOTION CODES =====

  @Get('promotion-codes')
  listPromotionCodes(@Query() q: PromotionCodeListQueryDto) {
    return this.stripe.listPromotionCodes({
      limit: q.limit,
      startingAfter: q.starting_after,
      endingBefore: q.ending_before,
      code: q.code,
      active: q.active,
      coupon: q.coupon,
    });
  }

  @Post('promotion-codes')
  createPromotionCode(@Body() dto: CreatePromotionCodeDto) {
    return this.stripe.createPromotionCode(dto);
  }

  @Patch('promotion-codes/:id')
  togglePromotionCode(@Param('id') id: string, @Body() dto: TogglePromotionCodeDto) {
    return this.stripe.setPromotionCodeActive(id, dto.active);
  }

  // ===== SUBSCRIPTIONS =====

  @Get('subscriptions')
  @ApiOperation({ summary: 'Lista assinaturas (filtros: status active|canceled|past_due|...)' })
  listSubscriptions(@Query() q: SubscriptionListQueryDto) {
    return this.stripe.listSubscriptions({
      limit: q.limit,
      startingAfter: q.starting_after,
      endingBefore: q.ending_before,
      customer: q.customer,
      status: q.status as Stripe.SubscriptionListParams.Status | undefined,
      priceId: q.priceId,
    });
  }

  @Get('subscriptions/:id')
  getSubscription(@Param('id') id: string) {
    return this.stripe.getSubscription(id);
  }

  @Post('subscriptions/:id/cancel')
  cancelSubscription(@Param('id') id: string, @Body() dto: CancelSubscriptionDto) {
    return this.stripe.cancelSubscription(id, dto.atPeriodEnd ?? true);
  }

  @Post('subscriptions/:id/reactivate')
  reactivateSubscription(@Param('id') id: string) {
    return this.stripe.reactivateSubscription(id);
  }

  // ===== INVOICES =====

  @Get('invoices')
  listInvoices(@Query() q: InvoiceListQueryDto) {
    return this.stripe.listInvoices({
      limit: q.limit,
      startingAfter: q.starting_after,
      endingBefore: q.ending_before,
      customer: q.customer,
      status: q.status as Stripe.InvoiceListParams.Status | undefined,
    });
  }

  @Get('invoices/:id')
  getInvoice(@Param('id') id: string) {
    return this.stripe.getInvoice(id);
  }
}
