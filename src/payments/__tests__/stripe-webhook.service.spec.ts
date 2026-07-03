import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { StripeWebhookService } from '../webhooks/stripe-webhook.service';
import { WebhookLogsService } from '../../webhook-logs/webhook-logs.service';
import { PaymentsService } from '../payments.service';
import { StripeService } from '../stripe.service';
import Stripe from 'stripe';

// ── Fixtures ─────────────────────────────────────────────────────────

const makeEvent = (
  type: string,
  data: Record<string, any>,
  id = 'evt_test_123',
): Stripe.Event =>
  ({
    id,
    type,
    data: { object: data },
  }) as unknown as Stripe.Event;

const mockCheckoutSession = (
  overrides: Partial<Stripe.Checkout.Session> & { metadata?: Record<string, string> } = {},
): Stripe.Checkout.Session =>
  ({
    id: 'cs_test_123',
    subscription: 'sub_test_123',
    amount_total: 2990,
    payment_intent: 'pi_test_123',
    metadata: {
      type: 'subscription',
      userId: 'user-1',
      planSlug: 'starter',
    },
    ...overrides,
  }) as unknown as Stripe.Checkout.Session;

const mockInvoice = (
  overrides: Partial<Stripe.Invoice> & Record<string, any> = {},
): Stripe.Invoice => {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'in_test_123',
    billing_reason: 'subscription_cycle',
    amount_paid: 2990,
    amount_due: 2990,
    parent: {
      subscription_details: {
        subscription: 'sub_test_123',
      },
    },
    lines: {
      data: [
        {
          period: {
            start: now,
            end: now + 30 * 24 * 60 * 60,
          },
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Invoice;
};

const mockSubscription = (
  overrides: Partial<Stripe.Subscription> = {},
): Stripe.Subscription =>
  ({
    id: 'sub_test_123',
    ...overrides,
  }) as unknown as Stripe.Subscription;

const mockCharge = (
  overrides: Partial<Stripe.Charge> = {},
): Stripe.Charge =>
  ({
    id: 'ch_test_123',
    payment_intent: 'pi_test_123',
    invoice: 'in_test_123',
    amount_refunded: 2990,
    ...overrides,
  }) as unknown as Stripe.Charge;

// ── Mocks ────────────────────────────────────────────────────────────

const mockWebhookLogsService = {
  findByExternalId: jest.fn(),
  create: jest.fn(),
  markProcessed: jest.fn(),
  markFailed: jest.fn(),
};

const mockPaymentsService = {
  processSubscriptionPayment: jest.fn(),
  processCreditPurchase: jest.fn(),
  handleSubscriptionRenewal: jest.fn(),
  handlePaymentFailed: jest.fn(),
  handleSubscriptionDeleted: jest.fn(),
  handleRefund: jest.fn(),
};

const mockStripeService = {
  constructWebhookEvent: jest.fn(),
};

describe('StripeWebhookService', () => {
  let service: StripeWebhookService;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockWebhookLogsService.findByExternalId.mockResolvedValue(null);
    mockWebhookLogsService.create.mockResolvedValue({ id: 'log-1' });
    mockWebhookLogsService.markProcessed.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StripeWebhookService,
        { provide: WebhookLogsService, useValue: mockWebhookLogsService },
        { provide: PaymentsService, useValue: mockPaymentsService },
        { provide: StripeService, useValue: mockStripeService },
      ],
    }).compile();

    service = module.get<StripeWebhookService>(StripeWebhookService);
  });

  // ── Verificação de assinatura ────────────────────────────────────

  describe('signature verification', () => {
    it('should throw BadRequestException when signature is invalid', async () => {
      mockStripeService.constructWebhookEvent.mockImplementation(() => {
        throw new Error('Invalid signature');
      });

      await expect(
        service.handleWebhook(Buffer.from('{}'), 'invalid-sig'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should include error message in the exception', async () => {
      mockStripeService.constructWebhookEvent.mockImplementation(() => {
        throw new Error('No signatures found matching the expected signature');
      });

      await expect(
        service.handleWebhook(Buffer.from('{}'), 'bad-sig'),
      ).rejects.toThrow('No signatures found matching the expected signature');
    });
  });

  // ── Idempotência ─────────────────────────────────────────────────

  describe('idempotency', () => {
    it('should skip already processed events', async () => {
      const event = makeEvent('checkout.session.completed', mockCheckoutSession());
      mockStripeService.constructWebhookEvent.mockReturnValue(event);
      mockWebhookLogsService.findByExternalId.mockResolvedValue({
        id: 'log-1',
        processed: true,
      });

      await service.handleWebhook(Buffer.from('{}'), 'valid-sig');

      expect(mockWebhookLogsService.create).not.toHaveBeenCalled();
      expect(mockPaymentsService.processSubscriptionPayment).not.toHaveBeenCalled();
    });

    it('should process events that were logged but not yet processed', async () => {
      const event = makeEvent('customer.subscription.deleted', mockSubscription());
      mockStripeService.constructWebhookEvent.mockReturnValue(event);
      mockWebhookLogsService.findByExternalId.mockResolvedValue({
        id: 'log-1',
        processed: false,
      });

      await service.handleWebhook(Buffer.from('{}'), 'valid-sig');

      expect(mockWebhookLogsService.create).toHaveBeenCalled();
      expect(mockPaymentsService.handleSubscriptionDeleted).toHaveBeenCalled();
    });
  });

  // ── checkout.session.completed (subscription) ────────────────────

  describe('checkout.session.completed — subscription', () => {
    it('should process subscription payment with correct params', async () => {
      const session = mockCheckoutSession();
      const event = makeEvent('checkout.session.completed', session);
      mockStripeService.constructWebhookEvent.mockReturnValue(event);

      await service.handleWebhook(Buffer.from('{}'), 'valid-sig');

      expect(mockPaymentsService.processSubscriptionPayment).toHaveBeenCalledWith(
        'user-1',
        'starter',
        'sub_test_123',
        2990,
        'pi_test_123',
      );
      expect(mockWebhookLogsService.markProcessed).toHaveBeenCalledWith('log-1');
    });

    it('should handle subscription as object (not string)', async () => {
      const session = mockCheckoutSession({
        subscription: { id: 'sub_obj_123' } as any,
      });
      const event = makeEvent('checkout.session.completed', session);
      mockStripeService.constructWebhookEvent.mockReturnValue(event);

      await service.handleWebhook(Buffer.from('{}'), 'valid-sig');

      expect(mockPaymentsService.processSubscriptionPayment).toHaveBeenCalledWith(
        'user-1',
        'starter',
        'sub_obj_123',
        2990,
        'pi_test_123',
      );
    });

    it('should not process when metadata is missing', async () => {
      const session = mockCheckoutSession({
        metadata: { type: 'subscription' },
      });
      const event = makeEvent('checkout.session.completed', session);
      mockStripeService.constructWebhookEvent.mockReturnValue(event);

      await service.handleWebhook(Buffer.from('{}'), 'valid-sig');

      expect(mockPaymentsService.processSubscriptionPayment).not.toHaveBeenCalled();
      expect(mockWebhookLogsService.markProcessed).toHaveBeenCalled();
    });
  });

  // ── checkout.session.completed (credit_purchase) ─────────────────

  describe('checkout.session.completed — credit_purchase', () => {
    it('should process credit purchase with correct params', async () => {
      const session = mockCheckoutSession({
        metadata: {
          type: 'credit_purchase',
          userId: 'user-1',
          packageId: 'pkg-500',
        },
        amount_total: 1790,
        payment_intent: 'pi_credit_123',
      });
      const event = makeEvent('checkout.session.completed', session);
      mockStripeService.constructWebhookEvent.mockReturnValue(event);

      await service.handleWebhook(Buffer.from('{}'), 'valid-sig');

      expect(mockPaymentsService.processCreditPurchase).toHaveBeenCalledWith(
        'user-1',
        'pkg-500',
        1790,
        'pi_credit_123',
      );
    });

    it('should not process credit purchase when metadata is incomplete', async () => {
      const session = mockCheckoutSession({
        metadata: { type: 'credit_purchase', userId: 'user-1' },
      });
      const event = makeEvent('checkout.session.completed', session);
      mockStripeService.constructWebhookEvent.mockReturnValue(event);

      await service.handleWebhook(Buffer.from('{}'), 'valid-sig');

      expect(mockPaymentsService.processCreditPurchase).not.toHaveBeenCalled();
    });
  });

  // ── invoice.payment_succeeded (renovação) ────────────────────────

  describe('invoice.payment_succeeded — renewal', () => {
    it('should process subscription renewal with correct period dates', async () => {
      const invoice = mockInvoice();
      const event = makeEvent('invoice.payment_succeeded', invoice);
      mockStripeService.constructWebhookEvent.mockReturnValue(event);

      await service.handleWebhook(Buffer.from('{}'), 'valid-sig');

      expect(mockPaymentsService.handleSubscriptionRenewal).toHaveBeenCalledWith(
        'sub_test_123',
        expect.any(Date),
        expect.any(Date),
        2990,
        'in_test_123',
      );

      const [, periodStart, periodEnd] =
        mockPaymentsService.handleSubscriptionRenewal.mock.calls[0];
      expect(periodEnd.getTime()).toBeGreaterThan(periodStart.getTime());
    });

    it('should skip invoice for subscription_create (first payment)', async () => {
      const invoice = mockInvoice({ billing_reason: 'subscription_create' });
      const event = makeEvent('invoice.payment_succeeded', invoice);
      mockStripeService.constructWebhookEvent.mockReturnValue(event);

      await service.handleWebhook(Buffer.from('{}'), 'valid-sig');

      expect(mockPaymentsService.handleSubscriptionRenewal).not.toHaveBeenCalled();
      expect(mockWebhookLogsService.markProcessed).toHaveBeenCalled();
    });

    it('should handle invoice without subscription ID gracefully', async () => {
      const invoice = mockInvoice({
        parent: { subscription_details: { subscription: undefined } } as any,
      });
      const event = makeEvent('invoice.payment_succeeded', invoice);
      mockStripeService.constructWebhookEvent.mockReturnValue(event);

      await service.handleWebhook(Buffer.from('{}'), 'valid-sig');

      expect(mockPaymentsService.handleSubscriptionRenewal).not.toHaveBeenCalled();
    });
  });

  // ── invoice.payment_failed ───────────────────────────────────────

  describe('invoice.payment_failed', () => {
    it('should mark subscription as PAST_DUE', async () => {
      const invoice = mockInvoice({ amount_due: 8990 });
      const event = makeEvent('invoice.payment_failed', invoice);
      mockStripeService.constructWebhookEvent.mockReturnValue(event);

      await service.handleWebhook(Buffer.from('{}'), 'valid-sig');

      expect(mockPaymentsService.handlePaymentFailed).toHaveBeenCalledWith(
        'sub_test_123',
        8990,
        'in_test_123',
      );
    });

    it('should handle invoice without subscription ID', async () => {
      const invoice = mockInvoice({
        parent: null as any,
      });
      const event = makeEvent('invoice.payment_failed', invoice);
      mockStripeService.constructWebhookEvent.mockReturnValue(event);

      await service.handleWebhook(Buffer.from('{}'), 'valid-sig');

      expect(mockPaymentsService.handlePaymentFailed).not.toHaveBeenCalled();
    });
  });

  // ── customer.subscription.deleted (cancelamento) ─────────────────

  describe('customer.subscription.deleted — cancellation', () => {
    it('should process subscription deletion', async () => {
      const subscription = mockSubscription({ id: 'sub_cancelled_123' });
      const event = makeEvent('customer.subscription.deleted', subscription);
      mockStripeService.constructWebhookEvent.mockReturnValue(event);

      await service.handleWebhook(Buffer.from('{}'), 'valid-sig');

      expect(mockPaymentsService.handleSubscriptionDeleted).toHaveBeenCalledWith(
        'sub_cancelled_123',
      );
      expect(mockWebhookLogsService.markProcessed).toHaveBeenCalled();
    });
  });

  // ── charge.refunded ──────────────────────────────────────────────

  describe('charge.refunded', () => {
    it('should process refund with payment_intent and invoice', async () => {
      const charge = mockCharge();
      const event = makeEvent('charge.refunded', charge);
      mockStripeService.constructWebhookEvent.mockReturnValue(event);

      await service.handleWebhook(Buffer.from('{}'), 'valid-sig');

      expect(mockPaymentsService.handleRefund).toHaveBeenCalledWith(
        'pi_test_123',
        'in_test_123',
        2990,
      );
    });

    it('should skip refund without payment_intent or invoice', async () => {
      const charge = mockCharge() as any;
      charge.payment_intent = null;
      charge.invoice = null;
      const event = makeEvent('charge.refunded', charge);
      mockStripeService.constructWebhookEvent.mockReturnValue(event);

      await service.handleWebhook(Buffer.from('{}'), 'valid-sig');

      expect(mockPaymentsService.handleRefund).not.toHaveBeenCalled();
    });
  });

  // ── Unhandled events ─────────────────────────────────────────────

  describe('unhandled events', () => {
    it('should log and mark processed for unknown event types', async () => {
      const event = makeEvent('payment_intent.created', { id: 'pi_123' });
      mockStripeService.constructWebhookEvent.mockReturnValue(event);

      await service.handleWebhook(Buffer.from('{}'), 'valid-sig');

      expect(mockWebhookLogsService.markProcessed).toHaveBeenCalled();
    });
  });

  // ── Error handling ───────────────────────────────────────────────

  describe('error handling', () => {
    it('should mark webhook as failed when processing throws', async () => {
      const event = makeEvent(
        'customer.subscription.deleted',
        mockSubscription(),
      );
      mockStripeService.constructWebhookEvent.mockReturnValue(event);
      mockPaymentsService.handleSubscriptionDeleted.mockRejectedValue(
        new Error('DB connection lost'),
      );

      await service.handleWebhook(Buffer.from('{}'), 'valid-sig');

      expect(mockWebhookLogsService.markFailed).toHaveBeenCalledWith(
        'log-1',
        'DB connection lost',
      );
      expect(mockWebhookLogsService.markProcessed).not.toHaveBeenCalled();
    });
  });
});
