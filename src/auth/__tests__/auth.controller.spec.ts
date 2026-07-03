import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from '../auth.controller';
import { AuthService } from '../auth.service';
import { RegisterDto } from '../dto/register.dto';
import { LoginDto } from '../dto/login.dto';
import { GoogleAuthDto } from '../dto/google-auth.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import { LogoutDto } from '../dto/logout.dto';
import { ForgotPasswordDto } from '../dto/forgot-password.dto';
import { ResetPasswordDto } from '../dto/reset-password.dto';

const mockAuthResponse = {
  accessToken: 'mock-access-token',
  refreshToken: 'mock-refresh-token',
  user: {
    id: 'user-1',
    email: 'test@example.com',
    name: 'Test User',
    avatarUrl: '',
    role: 'USER',
    emailVerified: false,
    createdAt: new Date(),
  },
};

const mockAuthService = {
  register: jest.fn().mockResolvedValue(mockAuthResponse),
  login: jest.fn().mockResolvedValue(mockAuthResponse),
  googleAuth: jest.fn().mockResolvedValue(mockAuthResponse),
  googleAuthWithToken: jest.fn().mockResolvedValue(mockAuthResponse),
  refreshTokens: jest.fn().mockResolvedValue(mockAuthResponse),
  logout: jest
    .fn()
    .mockResolvedValue({ message: 'Logout realizado com sucesso' }),
  forgotPassword: jest.fn().mockResolvedValue({
    message: 'Se o email existir, instruções de reset serão enviadas',
  }),
  resetPassword: jest
    .fn()
    .mockResolvedValue({ message: 'Senha alterada com sucesso' }),
};

describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: mockAuthService }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('register', () => {
    const registerDto: RegisterDto = {
      email: 'test@example.com',
      name: 'Test User',
      password: 'SecurePassword123!',
    };

    it('should call authService.register with dto and return result', async () => {
      const result = await controller.register(registerDto, { headers: {} } as any);

      expect(mockAuthService.register).toHaveBeenCalled();
      expect(mockAuthService.register).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockAuthResponse);
    });
  });

  describe('login', () => {
    const loginDto: LoginDto = {
      email: 'test@example.com',
      password: 'SecurePassword123!',
    };

    it('should call authService.login with email and password and return result', async () => {
      const result = await controller.login(loginDto);

      expect(mockAuthService.login).toHaveBeenCalledWith(
        loginDto.email,
        loginDto.password,
      );
      expect(mockAuthService.login).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockAuthResponse);
    });
  });

  describe('googleAuthMobile', () => {
    const googleAuthDto: GoogleAuthDto = {
      googleToken: 'mock-google-token',
    };

    it('should call authService.googleAuthWithToken with googleToken', async () => {
      const result = await controller.googleAuthMobile(googleAuthDto, { headers: {} } as any);

      expect(mockAuthService.googleAuthWithToken).toHaveBeenCalled();
      expect(mockAuthService.googleAuthWithToken).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockAuthResponse);
    });
  });

  describe('refresh', () => {
    const refreshTokenDto: RefreshTokenDto = {
      refreshToken: 'mock-refresh-token',
    };

    it('should call authService.refreshTokens with refreshToken', async () => {
      const result = await controller.refresh(refreshTokenDto);

      expect(mockAuthService.refreshTokens).toHaveBeenCalledWith(
        refreshTokenDto.refreshToken,
      );
      expect(mockAuthService.refreshTokens).toHaveBeenCalledTimes(1);
      expect(result).toEqual(mockAuthResponse);
    });
  });

  describe('logout', () => {
    const logoutDto: LogoutDto = {
      refreshToken: 'mock-refresh-token',
    };

    it('should call authService.logout with refreshToken and return success message', async () => {
      const result = await controller.logout(logoutDto);

      expect(mockAuthService.logout).toHaveBeenCalledWith(
        logoutDto.refreshToken,
      );
      expect(mockAuthService.logout).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ message: 'Logout realizado com sucesso' });
    });
  });

  describe('forgotPassword', () => {
    const forgotPasswordDto: ForgotPasswordDto = {
      email: 'test@example.com',
    };

    it('should call authService.forgotPassword with email', async () => {
      const result = await controller.forgotPassword(forgotPasswordDto);

      expect(mockAuthService.forgotPassword).toHaveBeenCalledWith(
        forgotPasswordDto.email,
      );
      expect(mockAuthService.forgotPassword).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        message: 'Se o email existir, instruções de reset serão enviadas',
      });
    });
  });

  describe('resetPassword', () => {
    const resetPasswordDto: ResetPasswordDto = {
      token: 'reset-token-123',
      password: 'NewSecurePassword123!',
    };

    it('should call authService.resetPassword with token and password', async () => {
      const result = await controller.resetPassword(resetPasswordDto);

      expect(mockAuthService.resetPassword).toHaveBeenCalledWith(
        resetPasswordDto.token,
        resetPasswordDto.password,
      );
      expect(mockAuthService.resetPassword).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ message: 'Senha alterada com sucesso' });
    });
  });
});
