import { ApiProperty } from '@nestjs/swagger';

export class UserResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ required: false })
  avatarUrl?: string;

  @ApiProperty()
  role: string;

  @ApiProperty()
  emailVerified: boolean;

  @ApiProperty()
  hasCompletedOnboarding: boolean;

  @ApiProperty({ required: false, nullable: true })
  termsAcceptedAt?: Date | null;

  @ApiProperty({ required: false, nullable: true })
  termsVersion?: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description: 'Quando a conta declarou a responsabilidade pelas imagens enviadas. Null = ainda não declarou.',
  })
  imageDeclarationAt?: Date | null;

  @ApiProperty()
  createdAt: Date;
}

export class AuthResponseDto {
  @ApiProperty()
  accessToken: string;

  @ApiProperty()
  refreshToken: string;

  @ApiProperty()
  user: UserResponseDto;

  @ApiProperty({ required: false, description: 'True when this auth flow created a new user' })
  isNewUser?: boolean;
}
