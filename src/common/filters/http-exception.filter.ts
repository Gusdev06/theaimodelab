import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const statusCode = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    let code = 'HTTP_ERROR';
    let message = exception.message;

    if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
      const resp = exceptionResponse as Record<string, any>;
      code = resp.code || resp.error || code;
      message = resp.message || message;

      // class-validator returns message as array
      if (Array.isArray(message)) {
        message = message[0];
      }
    }

    this.logger.warn(`HTTP ${statusCode}: ${code} - ${message}`);

    response.status(statusCode).json({
      success: false,
      error: {
        code,
        message,
        statusCode,
      },
    });
  }
}
