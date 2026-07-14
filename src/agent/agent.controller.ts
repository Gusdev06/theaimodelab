import {
  Body,
  Controller,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { AgentService } from './agent.service';
import { AgentChatDto } from './dto/agent-chat.dto';
import { CurrentUser, JwtPayload } from '../common/decorators';

@Controller('api/v1/agent')
export class AgentController {
  constructor(private readonly service: AgentService) {}

  @Post('chat')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async chat(@CurrentUser() user: JwtPayload, @Body() dto: AgentChatDto) {
    return this.service.chat(user.sub, dto);
  }
}
