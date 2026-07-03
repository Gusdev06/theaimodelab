import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminVertexService } from './admin-vertex.service';
import { CreateVertexCredentialDto } from './dto/create-vertex-credential.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';

@ApiTags('admin')
@ApiBearerAuth()
@Controller('api/v1/admin/vertex')
@UseGuards(RolesGuard)
@Roles('ADMIN')
export class AdminVertexController {
  constructor(private readonly service: AdminVertexService) {}

  @Get('credentials')
  @ApiOperation({ summary: 'Lista as contas Vertex configuradas no AI Model Lab Provider' })
  async listCredentials() {
    return this.service.listCredentials();
  }

  @Post('credentials')
  @ApiOperation({ summary: 'Adiciona uma nova conta Vertex ao The AI Model Lab Provider' })
  async createCredential(@Body() dto: CreateVertexCredentialDto) {
    return this.service.createCredential(dto);
  }

  @Delete('credentials/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove uma conta Vertex do AI Model Lab Provider' })
  async deleteCredential(@Param('id') id: string) {
    await this.service.deleteCredential(id);
  }
}
