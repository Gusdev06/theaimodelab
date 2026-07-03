# Subscriptions - Assinaturas

Base: `/api/v1/subscriptions`

Todas as rotas exigem **autenticacao** (`Authorization: Bearer <token>`).

---

## GET /subscriptions/current

Retorna a assinatura atual do usuario.

**Response 200:**

```json
{
  "id": "clx1sub001...",
  "status": "ACTIVE",
  "currentPeriodStart": "2026-03-01T00:00:00.000Z",
  "currentPeriodEnd": "2026-04-01T00:00:00.000Z",
  "cancelAtPeriodEnd": false,
  "paymentProvider": "stripe",
  "paymentRetryCount": 0,
  "createdAt": "2026-01-15T10:00:00.000Z",
  "plan": {
    "id": "clx1plan003...",
    "slug": "pro",
    "name": "Pro",
    "priceCents": 8990,
    "creditsPerMonth": 3500,
    "maxConcurrentGenerations": 5,
    "hasWatermark": false,
    "galleryRetentionDays": null,
    "hasApiAccess": false
  }
}
```

> Retorna `null` se o usuario nao possuir assinatura ativa.

---

## POST /subscriptions

Cria uma nova assinatura. Retorna a URL do Stripe Checkout para o usuario completar o pagamento.

**Request:**

```json
{
  "planSlug": "starter"
}
```

| Campo | Tipo | Obrigatorio | Valores |
|---|---|---|---|
| `planSlug` | string | Sim | `"starter"`, `"pro"`, `"business"` |

**Response 201:**

```json
{
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_..."
}
```

**Fluxo no Frontend:**
1. Chamar `POST /subscriptions` com o slug do plano
2. Redirecionar o usuario para `checkoutUrl`
3. Apos pagamento, Stripe redireciona de volta para o app
4. A assinatura e ativada automaticamente via webhook

**Erros:**

| Status | Descricao |
|---|---|
| 400 | Dados invalidos |
| 401 | Nao autenticado |
| 409 | Ja possui assinatura ativa |

---

## PATCH /subscriptions/upgrade

Upgrade imediato de plano. Creditos pro-rata sao adicionados.

**Request:**

```json
{
  "planSlug": "pro"
}
```

| Campo | Tipo | Obrigatorio |
|---|---|---|
| `planSlug` | string | Sim |

**Response 200:** Mesmo formato do `GET /subscriptions/current`.

**Erros:**

| Status | Descricao |
|---|---|
| 400 | Plano nao e superior ao atual |
| 401 | Nao autenticado |
| 404 | Nenhuma assinatura ativa |

---

## PATCH /subscriptions/downgrade

Agenda downgrade para o proximo ciclo de cobranca.

**Request:**

```json
{
  "planSlug": "starter"
}
```

| Campo | Tipo | Obrigatorio |
|---|---|---|
| `planSlug` | string | Sim |

**Response 200:** Mesmo formato do `GET /subscriptions/current`.

**Erros:**

| Status | Descricao |
|---|---|
| 400 | Plano nao e inferior ao atual |
| 401 | Nao autenticado |
| 404 | Nenhuma assinatura ativa |

---

## POST /subscriptions/cancel

Cancela a assinatura. O usuario mantem acesso ate o final do periodo pago, depois vira Free.

**Request:** Nenhum body necessario.

**Response 200:** Mesmo formato do `GET /subscriptions/current`, com `cancelAtPeriodEnd: true`.

**Erros:**

| Status | Descricao |
|---|---|
| 400 | Assinatura ja cancelada |
| 401 | Nao autenticado |
| 404 | Nenhuma assinatura ativa |

---

## POST /subscriptions/reactivate

Reativa uma assinatura que foi marcada para cancelamento (antes do periodo expirar).

**Request:** Nenhum body necessario.

**Response 200:** Mesmo formato do `GET /subscriptions/current`, com `cancelAtPeriodEnd: false`.

**Erros:**

| Status | Descricao |
|---|---|
| 401 | Nao autenticado |
| 404 | Nenhuma assinatura com cancelamento pendente |

---

## Tipos TypeScript para o Frontend

```typescript
interface Subscription {
  id: string;
  status: "ACTIVE" | "CANCELED" | "PAST_DUE" | "TRIALING";
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  paymentProvider: string | null;
  paymentRetryCount: number;
  createdAt: string;
  plan: SubscriptionPlan;
}

interface SubscriptionPlan {
  id: string;
  slug: string;
  name: string;
  priceCents: number;
  creditsPerMonth: number;
  maxConcurrentGenerations: number;
  hasWatermark: boolean;
  galleryRetentionDays: number | null;
  hasApiAccess: boolean;
}

interface CreateSubscriptionRequest {
  planSlug: string;
}

interface CreateSubscriptionResponse {
  checkoutUrl: string;
}
```

## Regras de Negocio Importantes

- **Upgrade**: imediato, creditos pro-rata adicionados
- **Downgrade**: efetivo no proximo ciclo
- **Cancelamento**: acesso ate fim do periodo pago, depois vira Free
- **Reativacao**: so funciona se `cancelAtPeriodEnd === true` e o periodo ainda nao expirou
- Se pagamento falhar: retry em 3 e 7 dias. Apos 3 falhas: downgrade automatico para Free
