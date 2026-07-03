# Admin - Painel Administrativo

Base: `/api/v1/admin`

Todas as rotas exigem **autenticacao** e **role `ADMIN`**.

Usuarios com role `USER` receberao erro 403 ao acessar estes endpoints.

---

## GET /admin/stats

Dashboard com estatisticas gerais da plataforma.

**Response 200:**

```json
{
  "totalUsers": 1250,
  "activeSubscriptions": 340,
  "totalRevenueCents": 15890000,
  "totalGenerations": 28500,
  "generationsByStatus": {
    "pending": 5,
    "processing": 12,
    "completed": 27800,
    "failed": 683
  }
}
```

> `totalRevenueCents` em centavos de BRL. Ex: `15890000` = R$ 158.900,00.

---

## GET /admin/users

Lista todos os usuarios (paginado).

**Query params:**

| Param | Tipo | Default |
|---|---|---|
| `page` | int | 1 |
| `limit` | int | 20 |
| `sort` | string | `created_at:desc` |

**Response 200:** Resposta paginada com array de usuarios.

---

## GET /admin/users/:id

Detalhes completos de um usuario especifico.

---

## PATCH /admin/users/:id/credits

Ajuste manual de creditos de um usuario.

**Request:**

```json
{
  "amount": 100,
  "description": "Compensacao por erro na geracao"
}
```

| Campo | Tipo | Obrigatorio | Descricao |
|---|---|---|---|
| `amount` | int | Sim | Positivo para adicionar, negativo para remover |
| `description` | string | Sim | Motivo do ajuste (max 500 chars) |

**Response 200:**

```json
{
  "success": true,
  "message": "Creditos ajustados com sucesso"
}
```

---

## GET /admin/generations

Lista todas as geracoes da plataforma (monitoramento).

**Query params:**

| Param | Tipo | Default |
|---|---|---|
| `page` | int | 1 |
| `limit` | int | 20 |
| `sort` | string | `created_at:desc` |

**Response 200:** Resposta paginada com array de geracoes.

---

## Tipos TypeScript para o Frontend

```typescript
interface AdminStats {
  totalUsers: number;
  activeSubscriptions: number;
  totalRevenueCents: number;
  totalGenerations: number;
  generationsByStatus: {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  };
}

interface AdjustCreditsRequest {
  amount: number;
  description: string;
}
```

> Este modulo geralmente so e usado no painel admin, nao no app principal do usuario.
