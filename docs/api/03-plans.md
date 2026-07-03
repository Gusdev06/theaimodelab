# Plans - Planos Disponiveis

Base: `/api/v1/plans`

---

## GET /plans

**[Publica]** — Nao exige autenticacao.

Lista todos os planos ativos, ordenados por `sortOrder`.

**Response 200:**

```json
[
  {
    "id": "clx1plan001...",
    "slug": "free",
    "name": "Free",
    "description": null,
    "priceCents": 0,
    "creditsPerMonth": 30,
    "maxConcurrentGenerations": 1,
    "hasWatermark": true,
    "galleryRetentionDays": 30,
    "hasApiAccess": false
  },
  {
    "id": "clx1plan002...",
    "slug": "starter",
    "name": "Starter",
    "description": null,
    "priceCents": 2990,
    "creditsPerMonth": 1000,
    "maxConcurrentGenerations": 2,
    "hasWatermark": false,
    "galleryRetentionDays": null,
    "hasApiAccess": false
  },
  {
    "id": "clx1plan003...",
    "slug": "pro",
    "name": "Pro",
    "description": null,
    "priceCents": 8990,
    "creditsPerMonth": 3500,
    "maxConcurrentGenerations": 5,
    "hasWatermark": false,
    "galleryRetentionDays": null,
    "hasApiAccess": false
  },
  {
    "id": "clx1plan004...",
    "slug": "business",
    "name": "Business",
    "description": null,
    "priceCents": 24990,
    "creditsPerMonth": 10000,
    "maxConcurrentGenerations": 10,
    "hasWatermark": false,
    "galleryRetentionDays": null,
    "hasApiAccess": true
  }
]
```

> `priceCents` esta em centavos de BRL. Ex: `2990` = R$ 29,90.
> `galleryRetentionDays: null` significa retencao ilimitada.

---

## Tipos TypeScript para o Frontend

```typescript
interface Plan {
  id: string;
  slug: "free" | "starter" | "pro" | "business";
  name: string;
  description: string | null;
  priceCents: number;
  creditsPerMonth: number;
  maxConcurrentGenerations: number;
  hasWatermark: boolean;
  galleryRetentionDays: number | null; // null = ilimitado
  hasApiAccess: boolean;
}
```

## Informacoes Uteis para o Frontend

| Plano | Preco Formatado | Creditos | Marca d'agua | Geracoes Simultaneas |
|---|---|---|---|---|
| Free | Gratis | 30/mes | Sim | 1 |
| Starter | R$ 29,90/mes | 1.000/mes | Nao | 2 |
| Pro | R$ 89,90/mes | 3.500/mes | Nao | 5 |
| Business | R$ 249,90/mes | 10.000/mes | Nao | 10 |

Para converter `priceCents` para display: `(priceCents / 100).toFixed(2)`
