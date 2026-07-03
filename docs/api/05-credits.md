# Credits - Creditos

Base: `/api/v1/credits`

Todas as rotas exigem **autenticacao** (`Authorization: Bearer <token>`).

---

## GET /credits/balance

Retorna o saldo detalhado de creditos do usuario.

**Response 200:**

```json
{
  "planCreditsRemaining": 2800,
  "bonusCreditsRemaining": 500,
  "totalCreditsAvailable": 3300,
  "planCreditsUsed": 700,
  "periodStart": "2026-03-01T00:00:00.000Z",
  "periodEnd": "2026-04-01T00:00:00.000Z"
}
```

| Campo | Descricao |
|---|---|
| `planCreditsRemaining` | Creditos do plano mensal restantes (expiram no fim do ciclo) |
| `bonusCreditsRemaining` | Creditos avulsos comprados (nao expiram) |
| `totalCreditsAvailable` | Soma de plan + bonus |
| `planCreditsUsed` | Creditos do plano ja consumidos neste ciclo |
| `periodStart` | Inicio do ciclo atual |
| `periodEnd` | Fim do ciclo atual (quando creditos do plano expiram) |

> `periodStart` e `periodEnd` podem ser `null` se o usuario nunca teve assinatura.

---

## GET /credits/transactions

Historico de transacoes de creditos (paginado).

**Query params:**

| Param | Tipo | Default |
|---|---|---|
| `page` | int | 1 |
| `limit` | int | 20 |
| `sort` | string | `created_at:desc` |

**Response 200:**

```json
{
  "data": [
    {
      "id": "clx1tx001...",
      "type": "GENERATION_DEBIT",
      "amount": -15,
      "source": "plan",
      "description": "Geracao text_to_image 2k",
      "generationId": "clx1gen001...",
      "paymentId": null,
      "createdAt": "2026-03-09T14:30:00.000Z"
    },
    {
      "id": "clx1tx002...",
      "type": "PURCHASE",
      "amount": 1000,
      "source": "bonus",
      "description": "Compra pacote 1.000 creditos",
      "generationId": null,
      "paymentId": "clx1pay001...",
      "createdAt": "2026-03-08T10:00:00.000Z"
    },
    {
      "id": "clx1tx003...",
      "type": "SUBSCRIPTION_RENEWAL",
      "amount": 3500,
      "source": "plan",
      "description": "Renovacao plano Pro",
      "generationId": null,
      "paymentId": "clx1pay002...",
      "createdAt": "2026-03-01T00:00:00.000Z"
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 45,
    "totalPages": 3
  }
}
```

| Tipo de Transacao | amount | Descricao |
|---|---|---|
| `SUBSCRIPTION_RENEWAL` | positivo | Renovacao mensal do plano |
| `PURCHASE` | positivo | Compra de pacote avulso |
| `GENERATION_DEBIT` | negativo | Consumo por geracao |
| `GENERATION_REFUND` | positivo | Estorno por geracao falhada |
| `REFERRAL_BONUS` | positivo | Bonus de indicacao |
| `ADMIN_ADJUSTMENT` | positivo/negativo | Ajuste manual do admin |

---

## GET /credits/packages

Lista pacotes de creditos avulsos disponiveis para compra.

**Response 200:**

```json
[
  {
    "id": "clx1pkg001...",
    "name": "Pacote 500",
    "credits": 500,
    "priceCents": 1790
  },
  {
    "id": "clx1pkg002...",
    "name": "Pacote 1.000",
    "credits": 1000,
    "priceCents": 2990
  },
  {
    "id": "clx1pkg003...",
    "name": "Pacote 5.000",
    "credits": 5000,
    "priceCents": 12990
  }
]
```

> `priceCents` em centavos de BRL. Ex: `1790` = R$ 17,90.

---

## POST /credits/purchase

Compra um pacote de creditos. Retorna URL do Stripe Checkout.

**Request:**

```json
{
  "packageId": "clx1pkg002..."
}
```

| Campo | Tipo | Obrigatorio |
|---|---|---|
| `packageId` | string | Sim |

**Response 200:**

```json
{
  "checkoutUrl": "https://checkout.stripe.com/c/pay/cs_test_..."
}
```

**Fluxo no Frontend:**
1. Chamar `POST /credits/purchase` com o ID do pacote
2. Redirecionar o usuario para `checkoutUrl`
3. Apos pagamento, Stripe redireciona de volta
4. Creditos sao adicionados automaticamente via webhook como `bonusCreditsRemaining`

---

## POST /credits/estimate

Calcula o custo em creditos de uma geracao **antes** de executar. Util para mostrar o custo ao usuario e verificar se ele tem saldo.

**Request:**

```json
{
  "type": "TEXT_TO_VIDEO",
  "resolution": "RES_1080P",
  "durationSeconds": 5,
  "hasAudio": true
}
```

| Campo | Tipo | Obrigatorio | Descricao |
|---|---|---|---|
| `type` | GenerationType | Sim | Tipo de geracao |
| `resolution` | Resolution | Sim | Resolucao desejada |
| `durationSeconds` | int | Nao | Duracao em segundos (obrigatorio para video) |
| `hasAudio` | boolean | Nao | Se o video deve ter audio (default: false) |

**Response 200:**

```json
{
  "creditsRequired": 480,
  "hasSufficientBalance": true
}
```

---

## Tabela de Custos de Creditos

| Operacao | Resolucao | Audio | Creditos | Unidade |
|---|---|---|---|---|
| TEXT_TO_IMAGE / IMAGE_TO_IMAGE | RES_1K | - | 10 | por imagem |
| TEXT_TO_IMAGE / IMAGE_TO_IMAGE | RES_2K | - | 15 | por imagem |
| TEXT_TO_IMAGE / IMAGE_TO_IMAGE | RES_4K | - | 22 | por imagem |
| MOTION_CONTROL | RES_720P | - | 7 | por segundo |
| MOTION_CONTROL | RES_1080P | - | 11 | por segundo |
| TEXT_TO_VIDEO / IMAGE_TO_VIDEO | RES_1080P | Nao | 48 | por segundo |
| TEXT_TO_VIDEO / IMAGE_TO_VIDEO | RES_4K | Nao | 96 | por segundo |
| TEXT_TO_VIDEO / IMAGE_TO_VIDEO | RES_1080P | Sim | 96 | por segundo |
| TEXT_TO_VIDEO / IMAGE_TO_VIDEO | RES_4K | Sim | 144 | por segundo |

**Calculo para videos:** `creditos = creditsPerUnit * durationSeconds`

Exemplo: Video 1080p com audio, 5 segundos = `96 * 5 = 480 creditos`

---

## Tipos TypeScript para o Frontend

```typescript
interface CreditBalance {
  planCreditsRemaining: number;
  bonusCreditsRemaining: number;
  totalCreditsAvailable: number;
  planCreditsUsed: number;
  periodStart: string | null;
  periodEnd: string | null;
}

interface CreditTransaction {
  id: string;
  type: "SUBSCRIPTION_RENEWAL" | "PURCHASE" | "GENERATION_DEBIT" | "GENERATION_REFUND" | "REFERRAL_BONUS" | "ADMIN_ADJUSTMENT";
  amount: number; // positivo = credito, negativo = debito
  source: "plan" | "bonus";
  description: string | null;
  generationId: string | null;
  paymentId: string | null;
  createdAt: string;
}

interface CreditPackage {
  id: string;
  name: string;
  credits: number;
  priceCents: number;
}

interface EstimateCostRequest {
  type: GenerationType;
  resolution: Resolution;
  durationSeconds?: number;
  hasAudio?: boolean;
}

interface EstimateCostResponse {
  creditsRequired: number;
  hasSufficientBalance: boolean;
}

interface PurchaseCreditsRequest {
  packageId: string;
}

interface PurchaseCreditsResponse {
  checkoutUrl: string;
}
```

## Regras de Negocio Importantes

- Creditos do plano **expiram** no fim do ciclo mensal
- Creditos avulsos (bonus) **nao expiram**
- No debito, o sistema consome primeiro creditos do plano, depois avulsos
- Geracoes com status `FAILED` sempre devolvem creditos automaticamente
