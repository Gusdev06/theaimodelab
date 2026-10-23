import {
  Body,
  Controller,
  Post,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { ContentSafetyInterceptor } from '../content-safety/content-safety.interceptor';
import { AgentService } from './agent.service';
import { AgentChatDto } from './dto/agent-chat.dto';
import { CurrentUser, JwtPayload } from '../common/decorators';

@Controller('api/v1/agent')
// a mensagem e o histórico passam pela trava de menor antes do agente; o prompt que o LLM escreve é conferido
// de novo no AgentService, antes de cada geração
@UseInterceptors(ContentSafetyInterceptor)
export class AgentController {
  constructor(private readonly service: AgentService) {}

  @Post('chat')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async chat(@CurrentUser() user: JwtPayload, @Body() dto: AgentChatDto) {
    return this.service.chat(user.sub, dto);
  }
}
