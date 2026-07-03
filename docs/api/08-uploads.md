# Uploads - Upload de Arquivos

Base: `/api/v1/uploads`

Todas as rotas exigem **autenticacao** (`Authorization: Bearer <token>`).

O upload de arquivos e feito via **presigned URL** — o frontend faz o upload diretamente para o S3/R2, sem passar pelo servidor da API.

---

## POST /uploads/presigned-url

Gera uma URL pre-assinada para upload de arquivo no S3/R2.

**Request:**

```json
{
  "filename": "photo.jpg",
  "contentType": "image/jpeg",
  "purpose": "generation_input"
}
```

| Campo | Tipo | Obrigatorio | Descricao |
|---|---|---|---|
| `filename` | string | Sim | Nome do arquivo |
| `contentType` | string | Sim | Tipo MIME do arquivo |
| `purpose` | string | Sim | Proposito do upload |

**Valores de `contentType`:**
```
"image/png" | "image/jpeg" | "image/webp" | "video/mp4"
```

**Valores de `purpose`:**
```
"generation_input" | "reference_video"
```

**Response 201:**

```json
{
  "uploadUrl": "https://s3.example.com/bucket/generation_input/550e8400.../photo.jpg?X-Amz-Algorithm=...",
  "fileKey": "generation_input/550e8400-e29b-41d4-a716-446655440000/photo.jpg"
}
```

| Campo | Descricao |
|---|---|
| `uploadUrl` | URL pre-assinada para fazer o PUT do arquivo |
| `fileKey` | Chave S3 do arquivo — usar como valor de `inputImageUrl` ou `referenceVideoUrl` nos endpoints de geracao |

---

## Fluxo Completo de Upload + Geracao

```typescript
// 1. Obter presigned URL
const { uploadUrl, fileKey } = await api.post('/uploads/presigned-url', {
  filename: 'photo.jpg',
  contentType: 'image/jpeg',
  purpose: 'generation_input',
});

// 2. Upload direto para S3/R2 (PUT request, sem auth da API)
await fetch(uploadUrl, {
  method: 'PUT',
  headers: { 'Content-Type': 'image/jpeg' },
  body: file, // File object do input
});

// 3. Usar fileKey no endpoint de geracao
const { id } = await api.post('/generations/image-to-image', {
  prompt: 'Transform into oil painting',
  inputImageUrl: fileKey,
  resolution: 'RES_2K',
});

// 4. Polling para acompanhar
// GET /generations/{id} a cada 3s
```

---

## Tipos TypeScript para o Frontend

```typescript
type UploadPurpose = "generation_input" | "reference_video";
type AllowedContentType = "image/png" | "image/jpeg" | "image/webp" | "video/mp4";

interface PresignedUrlRequest {
  filename: string;
  contentType: AllowedContentType;
  purpose: UploadPurpose;
}

interface PresignedUrlResponse {
  uploadUrl: string;
  fileKey: string;
}
```

## Limites

- Formatos aceitos: PNG, JPG, WEBP (imagem), MP4 (video)
- Outros formatos serao rejeitados com erro 400
