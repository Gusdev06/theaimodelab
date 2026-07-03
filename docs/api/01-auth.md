# Auth - Autenticacao

Base: `POST /api/v1/auth`

Todas as rotas deste modulo sao **publicas** (nao exigem Bearer token).

---

## POST /auth/register

Cadastro com email e senha.

**Request:**

```json
{
  "email": "john.doe@example.com",
  "name": "John Doe",
  "password": "SecurePassword123!"
}
```

| Campo | Tipo | Obrigatorio | Validacao |
|---|---|---|---|
| `email` | string | Sim | Email valido |
| `name` | string | Sim | Min 2, max 100 caracteres |
| `password` | string | Sim | Min 8, max 100 chars. Deve conter pelo menos: 1 maiuscula, 1 minuscula, 1 numero |

**Response 201:**

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "clx1abc2300001...",
    "email": "john.doe@example.com",
    "name": "John Doe",
    "avatarUrl": null,
    "role": "USER",
    "emailVerified": false,
    "createdAt": "2026-03-09T12:00:00.000Z"
  }
}
```

**Erros:**

| Status | Descricao |
|---|---|
| 400 | Dados invalidos (validacao) |
| 409 | Email ja cadastrado |

---

## POST /auth/login

Login com email e senha.

**Request:**

```json
{
  "email": "john.doe@example.com",
  "password": "SecurePassword123!"
}
```

| Campo | Tipo | Obrigatorio |
|---|---|---|
| `email` | string | Sim |
| `password` | string | Sim |

**Response 200:**

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "clx1abc2300001...",
    "email": "john.doe@example.com",
    "name": "John Doe",
    "avatarUrl": null,
    "role": "USER",
    "emailVerified": false,
    "createdAt": "2026-03-09T12:00:00.000Z"
  }
}
```

**Erros:**

| Status | Descricao |
|---|---|
| 400 | Dados invalidos |
| 401 | Email ou senha incorretos |

---

## GET /auth/google

Inicia fluxo OAuth com Google (redirect server-side). O navegador sera redirecionado para a pagina de login do Google.

**Uso:** Redirecionar o usuario para `GET /api/v1/auth/google`.

---

## GET /auth/google/callback

Callback do Google OAuth. O Google redireciona de volta para esta rota apos o login. Retorna tokens JWT.

**Response 200:** Mesmo formato do login (accessToken, refreshToken, user).

---

## POST /auth/google

Login/cadastro via Google OAuth para **mobile apps** e **SPAs** que obtem o token Google no client-side.

**Request:**

```json
{
  "googleToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

| Campo | Tipo | Obrigatorio |
|---|---|---|
| `googleToken` | string | Sim |

**Response 200:** Mesmo formato do login (accessToken, refreshToken, user).

**Erros:**

| Status | Descricao |
|---|---|
| 400 | Token Google invalido |

---

## POST /auth/refresh

Renova o access token usando o refresh token.

**Request:**

```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

| Campo | Tipo | Obrigatorio |
|---|---|---|
| `refreshToken` | string | Sim |

**Response 200:** Mesmo formato do login (accessToken, refreshToken, user).

**Erros:**

| Status | Descricao |
|---|---|
| 401 | Token invalido ou expirado |

---

## POST /auth/logout

Revoga o refresh token.

**Request:**

```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Response 200:**

```json
{
  "message": "Logout realizado com sucesso"
}
```

---

## POST /auth/forgot-password

Solicita reset de senha. Envia email com token de reset.

**Request:**

```json
{
  "email": "john.doe@example.com"
}
```

| Campo | Tipo | Obrigatorio |
|---|---|---|
| `email` | string | Sim |

**Response 200:**

```json
{
  "message": "Se o email existir, as instrucoes foram enviadas."
}
```

> A API sempre retorna 200 para nao revelar se o email existe.

---

## POST /auth/reset-password

Reseta a senha usando o token recebido por email.

**Request:**

```json
{
  "token": "a1b2c3d4e5f6...",
  "password": "NewSecurePassword123!"
}
```

| Campo | Tipo | Obrigatorio | Validacao |
|---|---|---|---|
| `token` | string | Sim | Token recebido por email |
| `password` | string | Sim | Mesmas regras do registro (min 8, maiuscula, minuscula, numero) |

**Response 200:**

```json
{
  "message": "Senha alterada com sucesso"
}
```

**Erros:**

| Status | Descricao |
|---|---|
| 400 | Token invalido ou expirado |

---

## Tipos TypeScript para o Frontend

```typescript
interface AuthResponse {
  accessToken: string;
  refreshToken: string;
  user: UserResponse;
}

interface UserResponse {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: "USER" | "ADMIN";
  emailVerified: boolean;
  createdAt: string; // ISO 8601
}
```

## Fluxo Recomendado no Frontend

1. **Login/Register** -> Salvar `accessToken` e `refreshToken` (localStorage ou httpOnly cookie)
2. Enviar `accessToken` no header `Authorization: Bearer <token>` em todas as requests autenticadas
3. Quando receber **401**, chamar `POST /auth/refresh` com o `refreshToken`
4. Se o refresh tambem falhar com 401, redirecionar para tela de login
5. No **logout**, chamar `POST /auth/logout` e limpar tokens locais
