import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmailModule } from '../email/email.module';
import { EmailService } from '../email/email.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), EmailModule],
})
class TestEmailModule {}

async function main() {
  const to = process.argv[2] ?? 'coven688@gmail.com';
  const name = process.argv[3] ?? 'Gustavo';

  const app = await NestFactory.createApplicationContext(TestEmailModule, {
    logger: ['log', 'warn', 'error'],
  });

  const emailService = app.get(EmailService);
  await emailService.sendPendingGrantsEmailEs(to, name);

  await app.close();
  console.log(`Tentativa de envio finalizada para ${to}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
