import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as express from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    bodyParser: false,
  });

  // Security headers (configured to not interfere with CORS)
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  // Body parsers that preserve rawBody for Stripe webhook verification
  app.use(express.json({ limit: '50mb', verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // Enable CORS with restricted origins
  const allowedOrigins = [
    ...(process.env.FRONTEND_URL?.split(',').map(u => u.trim()) ?? []),
    'https://theaimodelab.ai',
    'http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002',
  ].filter(Boolean);

  // Build a set of all allowed origins including www/non-www and http/https variants
  const allAllowedOrigins = new Set<string>();
  for (const origin of allowedOrigins) {
    allAllowedOrigins.add(origin);
    try {
      const url = new URL(origin);
      // Add www variant if not present, and vice-versa
      if (url.hostname.startsWith('www.')) {
        url.hostname = url.hostname.slice(4);
      } else {
        url.hostname = `www.${url.hostname}`;
      }
      allAllowedOrigins.add(url.origin);
    } catch {}
  }

  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (allAllowedOrigins.has(origin)) return callback(null, true);

      console.warn(`CORS blocked origin: ${origin}`);
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }));

  // Swagger configuration — only in non-production environments
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('The AI Model Lab API')
      .setDescription('API para geração de imagens e vídeos com IA')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env.PORT || 3000;
  await app.listen(port);

  console.log(`API running on http://localhost:${port}`);
  if (process.env.NODE_ENV !== 'production') {
    console.log(`Swagger docs available at http://localhost:${port}/api/docs`);
  }
}
bootstrap();
