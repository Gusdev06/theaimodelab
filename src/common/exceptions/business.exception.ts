import { HttpException } from '@nestjs/common';
import { ErrorCodes, ErrorCode } from '../constants/error-codes';

export class BusinessException extends HttpException {
  constructor(errorCode: ErrorCode, customMessage?: string) {
    const error = ErrorCodes[errorCode];
    super(
      {
        code: error.code,
        message: customMessage || error.message,
        statusCode: error.statusCode,
      },
      error.statusCode,
    );
  }
}
