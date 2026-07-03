import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators';
import { CommunityService } from './community.service';
import { SubmitCommunityPostDto } from './dto/community.dto';

@ApiTags('community')
@ApiBearerAuth()
@Controller('api/v1/community')
export class CommunityController {
  constructor(private readonly communityService: CommunityService) {}

  @Get('posts')
  @ApiOperation({ summary: 'Feed da comunidade (posts aprovados)' })
  @ApiResponse({ status: 200, description: 'Feed retornado com sucesso' })
  async feed(
    @CurrentUser('sub') userId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.communityService.feed(
      userId,
      Math.max(1, parseInt(page ?? '1', 10) || 1),
      Math.min(60, Math.max(1, parseInt(limit ?? '30', 10) || 30)),
    );
  }

  @Get('posts/mine')
  @ApiOperation({ summary: 'Posts do usuario (com status de moderacao)' })
  @ApiResponse({ status: 200, description: 'Posts retornados com sucesso' })
  async mine(@CurrentUser('sub') userId: string) {
    return this.communityService.mine(userId);
  }

  @Get('posts/:id')
  @ApiOperation({ summary: 'Obter uma publicacao aprovada (link compartilhado)' })
  async getPost(
    @CurrentUser('sub') userId: string,
    @Param('id') postId: string,
  ) {
    return this.communityService.getPost(userId, postId);
  }

  @Post('posts')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'Enviar uma geracao para aprovacao na comunidade' })
  @ApiResponse({ status: 201, description: 'Post enviado para analise' })
  async submit(
    @CurrentUser('sub') userId: string,
    @Body() dto: SubmitCommunityPostDto,
  ) {
    return this.communityService.submit(userId, dto);
  }

  @Post('posts/:id/like')
  @ApiOperation({ summary: 'Curtir um post' })
  @ApiResponse({ status: 201, description: 'Post curtido' })
  async like(@CurrentUser('sub') userId: string, @Param('id') postId: string) {
    return this.communityService.like(userId, postId);
  }

  @Get('me/follow-stats')
  @ApiOperation({ summary: 'Seguidores e seguindo do usuario atual' })
  async followStats(@CurrentUser('sub') userId: string) {
    return this.communityService.followStats(userId);
  }

  @Get('me/followers')
  @ApiOperation({ summary: 'Lista de quem segue o usuario' })
  async followers(@CurrentUser('sub') userId: string) {
    return this.communityService.listFollowers(userId);
  }

  @Get('me/following')
  @ApiOperation({ summary: 'Lista de quem o usuario segue' })
  async following(@CurrentUser('sub') userId: string) {
    return this.communityService.listFollowing(userId);
  }

  @Get('users/:id')
  @ApiOperation({ summary: 'Perfil publico de um usuario' })
  async publicProfile(
    @CurrentUser('sub') userId: string,
    @Param('id') targetId: string,
  ) {
    return this.communityService.publicProfile(userId, targetId);
  }

  @Get('users/:id/posts')
  @ApiOperation({ summary: 'Publicacoes aprovadas de um usuario' })
  async userPosts(
    @CurrentUser('sub') userId: string,
    @Param('id') targetId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.communityService.userPosts(
      userId,
      targetId,
      Math.max(1, parseInt(page ?? '1', 10) || 1),
      Math.min(60, Math.max(1, parseInt(limit ?? '30', 10) || 30)),
    );
  }

  @Post('users/:id/follow')
  @ApiOperation({ summary: 'Seguir um usuario' })
  @ApiResponse({ status: 201, description: 'Usuario seguido' })
  async follow(
    @CurrentUser('sub') userId: string,
    @Param('id') targetId: string,
  ) {
    return this.communityService.follow(userId, targetId);
  }

  @Delete('users/:id/follow')
  @ApiOperation({ summary: 'Deixar de seguir um usuario' })
  @ApiResponse({ status: 200, description: 'Deixou de seguir' })
  async unfollow(
    @CurrentUser('sub') userId: string,
    @Param('id') targetId: string,
  ) {
    return this.communityService.unfollow(userId, targetId);
  }

  @Delete('posts/:id/like')
  @ApiOperation({ summary: 'Remover curtida de um post' })
  @ApiResponse({ status: 200, description: 'Curtida removida' })
  async unlike(
    @CurrentUser('sub') userId: string,
    @Param('id') postId: string,
  ) {
    return this.communityService.unlike(userId, postId);
  }
}
