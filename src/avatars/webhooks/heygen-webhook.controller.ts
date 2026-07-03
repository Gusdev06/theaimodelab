import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../../common/decorators';
import { HeyGenProvider } from '../providers/heygen.provider';
import { HeyGenWebhookEvent, HeyGenWebhookService } from './heygen-webhook.service';

/** HeyGen doesn't publicly document the exact header name. Try the common
 *  variants — first one to be present (with a non-empty value) wins. */
const SIGNATURE_HEADER_CANDIDATES = [
  'x-heygen-signature',
  'heygen-signature',
  'x-hmac-signature',
  'x-signature',
  'x-signature-256',
  'x-hub-signature-256',
  'signature',
  'webhook-signature',
  'svix-signature',
];

@ApiTags('webhooks')
@Controller('api/v1/webhooks')
export class HeyGenWebhookController {
  private readonly logger = new Logger(HeyGenWebhookController.name);

  constructor(
    private readonly heygen: HeyGenProvider,
    private readonly webhookService: HeyGenWebhookService,
  ) {}

  @Public()
  @Post('heygen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'HeyGen webhook endpoint (avatar + video events)' })
  @ApiResponse({ status: 200, description: 'Webhook processed' })
  @ApiResponse({ status: 401, description: 'Invalid signature' })
  @ApiResponse({ status: 400, description: 'Invalid payload' })
  async heygenWebhook(
    @Req() req: RawBodyRequest<Request>,
  ): Promise<{ received: true }> {
    const rawBuffer = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    const rawString = rawBuffer.toString('utf8');

    // Find which header carries the signature
    let signature: string | undefined;
    let signatureHeader: string | undefined;
    for (const name of SIGNATURE_HEADER_CANDIDATES) {
      const value = req.headers[name];
      if (typeof value === 'string' && value.length > 0) {
        signature = value;
        signatureHeader = name;
        break;
      }
    }

    if (!this.heygen.verifyWebhookSignature(rawString, signature)) {
      // Log all incoming headers so we can identify which one HeyGen uses
      const headerDump = Object.entries(req.headers)
        .map(([k, v]) => `${k}=${String(v).slice(0, 80)}`)
        .join(' | ');
      this.logger.warn(
        `[heygen-webhook] invalid signature — usedHeader=${signatureHeader ?? 'NONE'} value=${signature?.slice(0, 24) ?? 'undefined'}... rawLen=${rawString.length}\n[heygen-webhook] all headers: ${headerDump}`,
      );
      throw new UnauthorizedException('Invalid signature');
    }

    let parsed: HeyGenWebhookEvent;
    try {
      parsed = JSON.parse(rawString) as HeyGenWebhookEvent;
    } catch {
      throw new BadRequestException('Invalid JSON payload');
    }
    if (!parsed.event_type || !parsed.event_data) {
      throw new BadRequestException('Missing event_type or event_data');
    }

    await this.webhookService.handle(parsed, parsed);
    return { received: true };
  }
}
