/**
 * Gera o par VAPID do Web Push (L16). Uso:
 *   npx ts-node scripts/generate-vapid-keys.ts "C:/Users/Bruno/Documents/CHAVES/vapid-taml.txt"
 * Grava as 2 linhas de env no arquivo indicado (nunca no chat nem no repo). Sem caminho, recusa.
 * Depois: WEB_PUSH_VAPID_PUBLIC_KEY e WEB_PUSH_VAPID_PRIVATE_KEY na API, NEXT_PUBLIC_PWA_PUSH=on no site e
 * WEB_PUSH_ENABLED=on na API. Trocar as chaves invalida as inscrições já feitas.
 */
import { writeFileSync } from 'fs';
import { generateVapidKeys } from '../src/web-push/web-push.crypto';

const target = process.argv[2];
if (!target) {
  process.stderr.write('Informe o arquivo de saída (ex.: Documents/CHAVES/vapid-taml.txt).\n');
  process.exit(1);
}
const keys = generateVapidKeys();
writeFileSync(target, `WEB_PUSH_VAPID_PUBLIC_KEY=${keys.publicKey}\nWEB_PUSH_VAPID_PRIVATE_KEY=${keys.privateKey}\n`, { flag: 'wx' });
process.stdout.write(`Chaves VAPID gravadas em ${target}\n`);
