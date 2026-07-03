import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateVertexCredentialDto {
  @ApiProperty({
    description: 'Nome de identificação da conta Vertex',
    example: 'account1',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiProperty({ description: 'OAuth Client ID da conta GCP' })
  @IsString()
  @IsNotEmpty()
  clientId: string;

  @ApiProperty({ description: 'OAuth Client Secret da conta GCP' })
  @IsString()
  @IsNotEmpty()
  clientSecret: string;

  @ApiProperty({ description: 'OAuth Refresh Token da conta GCP' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;

  @ApiProperty({
    description: 'Quota Project ID do GCP',
    example: 'project-3466d30f-969d-449c-84a',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  quotaProjectId: string;
}
