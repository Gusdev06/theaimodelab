import {
  Controller,
  Get,
  Patch,
  Delete,
  Body,
  HttpCode,
  HttpStatus,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserProfileResponseDto } from './dto/user-profile-response.dto';
import { CurrentUser } from '../common/decorators';

@ApiTags('users')
@ApiBearerAuth()
@Controller('api/v1/users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Perfil do usuário logado' })
  @ApiResponse({
    status: 200,
    description: 'Perfil retornado com sucesso',
    type: UserProfileResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  async getProfile(
    @CurrentUser('sub') userId: string,
  ): Promise<UserProfileResponseDto> {
    return this.usersService.getProfile(userId);
  }

  @Patch('me')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Atualizar perfil' })
  @ApiResponse({
    status: 200,
    description: 'Perfil atualizado com sucesso',
    type: UserProfileResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  async updateProfile(
    @CurrentUser('sub') userId: string,
    @Body() dto: UpdateUserDto,
  ): Promise<UserProfileResponseDto> {
    return this.usersService.updateProfile(userId, dto);
  }

  @Patch('me/onboarding')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Marcar onboarding como concluído' })
  @ApiResponse({
    status: 200,
    description: 'Onboarding concluído',
    type: UserProfileResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  async completeOnboarding(
    @CurrentUser('sub') userId: string,
  ): Promise<UserProfileResponseDto> {
    return this.usersService.completeOnboarding(userId);
  }

  @Delete('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Desativar conta (soft delete)' })
  @ApiResponse({
    status: 200,
    description: 'Conta desativada com sucesso',
  })
  @ApiResponse({ status: 401, description: 'Não autenticado' })
  async deleteAccount(
    @CurrentUser('sub') userId: string,
  ): Promise<{ message: string }> {
    return this.usersService.deleteAccount(userId);
  }
}
