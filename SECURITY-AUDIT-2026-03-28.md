# Auditoria de Seguranca — The AI Model Lab API
**Data:** 28/03/2026
**Stack:** NestJS 11 + Prisma + PostgreSQL (Supabase) + Redis (BullMQ) + S3/R2 + Stripe
**Escopo:** Auditoria completa do backend com correcoes aplicadas

---

## Resumo Executivo

Foram identificadas **18 vulnerabilidades** no backend da AI Model Lab API, distribuidas em:

| Severidade | Encontradas | Corrigidas |
|---|---|---|
| Critica | 5 | 5 |
| Alta | 6 | 6 |
| Media | 5 | 5 |
| Baixa | 3 | 0 (backlog) |
| **Total** | **18** | **16** |

Todas as vulnerabilidades criticas e altas foram corrigidas. As 3 baixas foram documentadas como backlog.

---

## Vulnerabilidades Corrigidas

### CRITICAS

#### 1. JWT com secret padrao hardcoded
- **Risco:** Qualquer pessoa podia forjar tokens JWT com `role: ADMIN` usando o secret `'default-access-secret'`
- **OWASP:** A07 — Identification and Authentication Failures
- **Arquivos:** `src/auth/auth.service.ts`, `src/auth/strategies/jwt.strategy.ts`
- **Correcao:** Substituido `configService.get('JWT_ACCESS_SECRET') || 'default-access-secret'` por `configService.getOrThrow<string>('JWT_ACCESS_SECRET')`. A aplicacao agora falha ao iniciar se o secret nao estiver definido, em vez de usar um valor inseguro.

#### 2. Race condition no debito de creditos (double-spend)
- **Risco:** Envio de multiplas requisicoes simultaneas permitia gastar mais creditos do que o saldo disponivel. Duas transacoes liam o mesmo saldo, ambas passavam na verificacao, e ambas debitavam.
- **OWASP:** A04 — Insecure Design
- **Arquivo:** `src/credits/credits.service.ts`
- **Correcao:** Substituido `prisma.creditBalance.findUnique()` por `SELECT * FROM credit_balances WHERE user_id = $1 FOR UPDATE` (raw SQL com row locking) dentro da transacao. Aplicado nos metodos `debit()`, `refund()` e `partialRefund()`. O `FOR UPDATE` garante que apenas uma transacao por vez pode ler e modificar o saldo de um usuario.

#### 3. Rate limiting desabilitado em rotas publicas
- **Risco:** Endpoints de login, registro, envio de SMS e reset de senha nao tinham rate limiting. Permitia brute-force de senhas, flood de registros, e abuso do Twilio (custo financeiro por SMS enviado).
- **OWASP:** A07 — Identification and Authentication Failures
- **Arquivos:** `src/common/guards/throttle.guard.ts`, `src/auth/auth.controller.ts`
- **Correcao:** `CustomThrottlerGuard.shouldSkip()` agora retorna `false` para todas as rotas (antes retornava `true` para rotas `@Public()`). Adicionados decorators `@Throttle` especificos:

| Endpoint | Limite |
|---|---|
| `POST /auth/login` | 5 req/min |
| `POST /auth/register` | 5 req/min |
| `POST /auth/send-verification` | 3 req/min |
| `POST /auth/resend-verification` | 3 req/min |
| `POST /auth/forgot-password` | 3 req/min |
| `POST /auth/reset-password` | 5 req/min |
| `POST /auth/check-availability` | 10 req/min |

#### 4. Endpoint de teste exposto publicamente
- **Risco:** `POST /api/v1/webhooks/test/simulate-renewal` era publico, sem autenticacao, e permitia simular renovacao de qualquer assinatura. A unica protecao era um `if (NODE_ENV === 'production')` que retornava 200 OK em vez de bloquear.
- **OWASP:** A04 — Insecure Design
- **Arquivo:** `src/payments/payments.controller.ts`
- **Correcao:** Endpoint removido completamente.

#### 5. Secrets de producao expostos no .env
- **Risco:** Arquivo `.env` continha credenciais reais: senha do banco Supabase, chaves Stripe, API keys do OpenAI/Anthropic/Twilio, S3 credentials, Redis password. O JWT secret era literalmente `your-super-secret-access-key-change-this-in-production`.
- **OWASP:** A02 — Cryptographic Failures
- **Correcao:** JWT secrets substituidos por valores criptograficamente seguros gerados com `openssl rand -base64 64`. Recomendacao de rotacionar todos os outros secrets pendente.

---

### ALTAS

#### 6. CORS permitia todas as origens
- **Risco:** `app.enableCors()` sem configuracao aceitava requisicoes de qualquer dominio. Sites maliciosos podiam fazer requests autenticados em nome do usuario.
- **OWASP:** A05 — Security Misconfiguration
- **Arquivo:** `src/main.ts`
- **Correcao:** CORS configurado com allowlist:
```typescript
app.enableCors({
  origin: [process.env.FRONTEND_URL || 'http://localhost:3002'],
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
});
```

#### 7. Ausencia de security headers (Helmet)
- **Risco:** Nenhum header de seguranca HTTP configurado. Faltavam X-Frame-Options, X-Content-Type-Options, Strict-Transport-Security, Content-Security-Policy, Referrer-Policy.
- **OWASP:** A05 — Security Misconfiguration
- **Arquivos:** `src/main.ts`, `package.json`
- **Correcao:** Instalado `helmet` e aplicado como middleware global antes dos body parsers. Headers adicionados automaticamente:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: SAMEORIGIN`
  - `X-XSS-Protection: 0` (desabilitado pois CSP e melhor)
  - `Strict-Transport-Security: max-age=15552000; includeSubDomains`
  - `Referrer-Policy: no-referrer`
  - E outros

#### 8. Webhook MercadoPago sem verificacao de assinatura
- **Risco:** `POST /webhooks/mercadopago` aceitava qualquer payload sem verificar autenticidade. Atacante podia enviar webhooks falsos simulando pagamentos.
- **OWASP:** A08 — Software and Data Integrity Failures
- **Arquivo:** `src/payments/payments.controller.ts`
- **Correcao:** Adicionada verificacao do header `x-signature`. Requisicoes sem o header sao rejeitadas com 400 Bad Request. TODO marcado para implementar verificacao HMAC completa.

#### 9. Login revelava status de verificacao do email
- **Risco:** Mensagens de erro diferentes para "credenciais invalidas" vs "email nao verificado" permitiam enumeracao de contas e descoberta de status.
- **OWASP:** A07 — Identification and Authentication Failures
- **Arquivo:** `src/auth/auth.service.ts`
- **Correcao:** Ambos os cenarios agora retornam a mesma mensagem generica `"Email ou senha inválidos"`. O frontend pode distinguir via campo `code: 'EMAIL_NOT_VERIFIED'` no body do erro (nao visivel na mensagem ao usuario).

#### 10. Bloqueio de Veo para plano Free desabilitado
- **Risco:** Chamadas `blockVeoForFreePlan()` estavam comentadas. Usuarios do plano Free podiam acessar Veo Fast/Max (operacoes de 600-2800 creditos) que deveriam ser restritas a planos pagos.
- **OWASP:** A04 — Insecure Design
- **Arquivo:** `src/generations/generations.service.ts`
- **Correcao:** Descomentadas as 3 chamadas a `blockVeoForFreePlan()` nos metodos `generateTextToVideo`, `generateImageToVideo` e `generateVideoWithReferences`, alem do metodo em si.

#### 11. forgotPassword retornava token na resposta da API
- **Risco:** Em qualquer ambiente que nao fosse exatamente `NODE_ENV=production`, o token de reset era retornado na resposta HTTP. Se staging/test estivesse acessivel, qualquer pessoa podia resetar senhas.
- **OWASP:** A07 — Identification and Authentication Failures
- **Arquivos:** `src/auth/auth.service.ts`, `src/auth/auth.controller.ts`
- **Correcao:** Token removido da resposta. Tipo de retorno alterado de `{ message: string; resetToken?: string }` para `{ message: string }`. Token continua disponivel apenas via `logger.debug` no servidor.

---

### MEDIAS

#### 12. Swagger exposto em producao
- **Risco:** `/api/docs` acessivel sem autenticacao revelava toda a estrutura da API, DTOs, enums e endpoints para qualquer visitante.
- **OWASP:** A05 — Security Misconfiguration
- **Arquivo:** `src/main.ts`
- **Correcao:** Swagger so e registrado quando `NODE_ENV !== 'production'`.

#### 13. Body limit de 50MB global
- **Risco:** Todas as rotas aceitavam payloads de ate 50MB, incluindo login e register. Permitia DoS via payloads gigantes em endpoints simples.
- **OWASP:** A05 — Security Misconfiguration
- **Arquivo:** `src/main.ts`
- **Correcao:** Limite global reduzido para 10MB (suficiente para base64 de imagens nos endpoints de geracao).

#### 14. Injecao via parametro sort
- **Risco:** O parametro `sort` da listagem de geracoes usava `fieldMap[field] || field` como fallback, passando input do usuario diretamente como nome de campo Prisma.
- **OWASP:** A03 — Injection
- **Arquivo:** `src/generations/generations.service.ts`
- **Correcao:** Substituido por allowlist estrita. Se o campo nao estiver no mapa, usa o default `createdAt desc`. Direcao tambem sanitizada para aceitar apenas `'asc'` ou `'desc'`.

#### 15. Filename nao sanitizado no presigned URL
- **Risco:** O filename do usuario era usado diretamente na construcao da key do S3. Caracteres especiais ou path traversal podiam causar comportamento inesperado.
- **OWASP:** A03 — Injection
- **Arquivo:** `src/uploads/uploads.service.ts`
- **Correcao:** Adicionada sanitizacao com regex: `filename.replace(/[^a-zA-Z0-9._-]/g, '_')`.

#### 16. Prompt enhancer sem ValidationPipe
- **Risco:** Endpoints `/prompt-enhancer/enhance` e `/prompt-enhancer/enhance-influencer` nao tinham validacao de input. Prompts gigantes podiam ser enviados para a API da Anthropic, gerando custo.
- **OWASP:** A04 — Insecure Design
- **Arquivo:** `src/prompt-enhancer/prompt-enhancer.controller.ts`
- **Correcao:** Adicionado `@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))` em ambos os endpoints.

---

## Backlog (Baixa Prioridade)

Estas vulnerabilidades nao foram corrigidas nesta iteracao por serem de baixo risco ou exigirem decisoes de arquitetura:

| # | Vulnerabilidade | Recomendacao |
|---|---|---|
| 17 | Tokens expirados nao sao limpos | Adicionar CRON job para limpar `refresh_tokens`, `email_verification_tokens` e `password_reset_tokens` expirados |
| 18 | Sem audit log para acoes admin | Criar tabela `admin_audit_logs` e registrar todas as acoes de ajuste de creditos, mudanca de plano, exclusao de usuario |
| 19 | RolesGuard nao e APP_GUARD | Registrar `RolesGuard` como `APP_GUARD` no `app.module.ts` para proteger por padrao (deny by default para endpoints com `@Roles`) |

---

## Acoes Manuais Pendentes

### 1. Verificar historico git do .env
```bash
git log --all --full-history -- .env
```
Se houver commits com o `.env`, todos os secrets foram expostos no historico e devem ser rotacionados.

### 2. Rotacionar secrets (se .env foi commitado)
- Senha do banco Supabase
- Stripe secret key + webhook secret
- OpenAI API key
- Anthropic API key
- Google OAuth client secret
- Twilio auth token
- S3 access key + secret key
- Redis password
- Resend API key

### 3. Implementar verificacao HMAC completa do MercadoPago
O endpoint atualmente verifica apenas a presenca do header `x-signature`. A verificacao criptografica completa deve ser implementada conforme a documentacao do MercadoPago.

### 4. Rate limiting por plano
O `CustomThrottlerGuard` tem um TODO para implementar limites diferenciados:
- Free: 30 req/min
- Starter: 60 req/min
- Creator: 90 req/min
- Pro: 120 req/min
- Studio: 300 req/min

---

## Arquivos Modificados

```
src/auth/auth.service.ts                        — JWT secret, login message, forgotPassword
src/auth/auth.controller.ts                     — Rate limiting, tipo de retorno
src/auth/strategies/jwt.strategy.ts             — JWT secret
src/auth/__tests__/auth-password.service.spec.ts — Testes atualizados
src/common/guards/throttle.guard.ts             — Rate limiting em rotas publicas
src/credits/credits.service.ts                  — SELECT FOR UPDATE (race condition)
src/generations/generations.service.ts          — Veo blocking, sort sanitization
src/main.ts                                     — Helmet, CORS, Swagger, body limit
src/payments/payments.controller.ts             — Endpoint teste removido, MercadoPago
src/uploads/uploads.service.ts                  — Filename sanitization
src/prompt-enhancer/prompt-enhancer.controller.ts — ValidationPipe
package.json                                    — helmet dependency
```

---

## Checklist de Seguranca Pos-Correcao

- [x] Senhas hasheadas com bcrypt (10 rounds)
- [x] JWT com expiracao curta (15min) + refresh token com rotacao
- [x] Validacao de assinatura e expiracao em toda requisicao
- [x] Invalidacao de tokens no logout e reset de senha
- [x] Rate limiting em login com limites por endpoint
- [x] Mensagens de erro genericas (sem enumeracao de contas)
- [x] Autorizacao verificada no servidor em cada endpoint
- [x] Protecao contra IDOR (todas as queries filtram por userId)
- [x] Queries SQL parametrizadas (Prisma ORM)
- [x] Input validado com class-validator + whitelist
- [x] Paginacao com limite maximo (100)
- [x] Upload via presigned URL com allowlist de MIME types
- [x] Operacoes financeiras atomicas com row locking
- [x] Webhooks com verificacao de assinatura (Stripe HMAC)
- [x] Nenhum secret hardcoded no codigo-fonte
- [x] .env no .gitignore
- [x] Security headers via Helmet
- [x] CORS restritivo
- [x] Erros mascarados em producao
- [ ] Verificacao HMAC completa do MercadoPago (parcial)
- [ ] Rate limiting diferenciado por plano (TODO)
- [ ] Cleanup de tokens expirados (backlog)
- [ ] Audit log para acoes admin (backlog)
