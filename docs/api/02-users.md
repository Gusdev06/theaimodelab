# Users - Perfil do Usuario

Base: `/api/v1/users`

Todas as rotas exigem **autenticacao** (`Authorization: Bearer <token>`).

---

## GET /users/me

Retorna perfil completo do usuario logado, incluindo plano, creditos e assinatura.

**Response 200:**

```json
{
  "id": "clx1abc2300001...",
  "email": "john.doe@example.com",
  "name": "John Doe",
  "avatarUrl": "https://example.com/avatar.jpg",
  "role": "USER",
  "emailVerified": true,
  "createdAt": "2026-01-15T10:00:00.000Z",
  "plan": {
    "slug": "pro",
    "name": "Pro",
    "priceCents": 8990,
    "maxConcurrentGenerations": 5,
    "hasWatermark": false,
    "hasApiAccess": false
  },
  "credits": {
    "planCreditsRemaining": 2800,
    "bonusCreditsRemaining": 500,
    "planCreditsUsed": 700,
    "periodStart": "2026-03-01T00:00:00.000Z",
    "periodEnd": "2026-04-01T00:00:00.000Z"
  },
  "subscription": {
    "status": "ACTIVE",
    "currentPeriodStart": "2026-03-01T00:00:00.000Z",
    "currentPeriodEnd": "2026-04-01T00:00:00.000Z",
    "cancelAtPeriodEnd": false
  }
}
```

> Campos `plan`, `credits` e `subscription` podem ser `null` se o usuario nao tiver assinatura (usuario Free sem historico).

**Erros:**

| Status | Descricao |
|---|---|
| 401 | Nao autenticado |

---

## PATCH /users/me

Atualiza o perfil do usuario.

**Request:**

```json
{
  "name": "John Updated",
  "avatarUrl": "https://example.com/new-avatar.jpg"
}
```

| Campo | Tipo | Obrigatorio | Validacao |
|---|---|---|---|
| `name` | string | Nao | Min 2, max 100 caracteres |
| `avatarUrl` | string | Nao | URL valida |

> Ambos os campos sao opcionais. Envie apenas os que deseja alterar.

**Response 200:** Mesmo formato do `GET /users/me`.

**Erros:**

| Status | Descricao |
|---|---|
| 400 | Dados invalidos |
| 401 | Nao autenticado |

---

## DELETE /users/me

Desativa a conta do usuario (soft delete). O usuario nao e removido do banco, apenas marcado como inativo.

**Response 200:**

```json
{
  "message": "Conta desativada com sucesso"
}
```

**Erros:**

| Status | Descricao |
|---|---|
| 401 | Nao autenticado |

---

## Tipos TypeScript para o Frontend

```typescript
interface UserProfile {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: "USER" | "ADMIN";
  emailVerified: boolean;
  createdAt: string;
  plan: PlanInfo | null;
  credits: CreditInfo | null;
  subscription: SubscriptionInfo | null;
}

interface PlanInfo {
  slug: string;
  name: string;
  priceCents: number;
  maxConcurrentGenerations: number;
  hasWatermark: boolean;
  hasApiAccess: boolean;
}

interface CreditInfo {
  planCreditsRemaining: number;
  bonusCreditsRemaining: number;
  planCreditsUsed: number;
  periodStart: string | null;
  periodEnd: string | null;
}

interface SubscriptionInfo {
  status: "ACTIVE" | "CANCELED" | "PAST_DUE" | "TRIALING";
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
}

interface UpdateUserRequest {
  name?: string;
  avatarUrl?: string;
}
```
