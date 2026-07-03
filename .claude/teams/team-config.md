# The AI Model Lab API - Agent Team Configuration

## Team Overview
Este time de agentes foi criado para desenvolver e manter o AI Model Lab API, um MicroSaaS de geração de imagens e vídeos com IA. O sistema oferece um modelo freemium baseado em créditos, integrando com múltiplos provedores de IA.

## Team Structure

### 1. Backend API Agent (`backend-api`)
**Focus:** Desenvolvimento da API REST com NestJS
**Expertise:** NestJS, TypeScript, JWT, OAuth, Rate Limiting
**Primary Tasks:** Endpoints, autenticação, validações, middleware

### 2. Database Agent (`database`)
**Focus:** PostgreSQL e modelagem de dados
**Expertise:** SQL, TypeORM, migrações, otimização
**Primary Tasks:** Schema design, índices, queries, integridade

### 3. Integrations Agent (`integrations`)
**Focus:** APIs externas e processamento assíncrono
**Expertise:** APIs de IA, webhooks, S3/R2, resiliência
**Primary Tasks:** Providers de IA, uploads, polling, circuit breakers

### 4. Payments Agent (`payments`)
**Focus:** Sistema de pagamentos e billing
**Expertise:** Stripe, Mercado Pago, assinaturas, compliance
**Primary Tasks:** Checkout, renovações, webhooks, pro-rata

### 5. Testing Agent (`testing`)
**Focus:** Qualidade e testes automatizados
**Expertise:** Jest, Supertest, mocks, coverage
**Primary Tasks:** Testes unitários, integração, E2E

### 6. DevOps Agent (`devops`)
**Focus:** Infraestrutura e deploy
**Expertise:** Docker, CI/CD, Cloud, monitoring
**Primary Tasks:** Deploy, backup, scaling, segurança

## Collaboration Protocol

### Task Assignment
```yaml
# Exemplos de atribuição por tipo de tarefa
"Criar endpoint de geração": backend-api
"Otimizar query de créditos": database
"Integrar com Veo 3.1": integrations
"Implementar checkout Stripe": payments
"Adicionar testes para créditos": testing
"Configurar pipeline CI/CD": devops
```

### Cross-Agent Communication
1. **Database ↔ Backend:** Schema changes, query optimization
2. **Backend ↔ Integrations:** Provider interfaces, async processing
3. **Backend ↔ Payments:** Transaction handling, subscription logic
4. **Testing ↔ All:** Test coverage, mocks, validation
5. **DevOps ↔ All:** Deploy requirements, env vars, monitoring

### Decision Making
- **Technical Decisions:** Agent especialista lidera, outros revisam
- **Architecture Changes:** Consenso entre backend-api, database, devops
- **Business Logic:** Seguir CLAUDE.md, payments agent valida monetização
- **Security:** Todos os agentes devem considerar OWASP Top 10

## Workflow Examples

### Example 1: Implementar Nova Feature de Geração
```
1. backend-api: Cria endpoint e validações
2. database: Ajusta schema se necessário
3. integrations: Implementa provider específico
4. payments: Valida consumo de créditos
5. testing: Adiciona testes completos
6. devops: Configura env vars e deploy
```

### Example 2: Otimização de Performance
```
1. database: Analisa queries lentas
2. backend-api: Implementa cache
3. devops: Configura CDN e monitoring
4. testing: Testes de carga
```

### Example 3: Novo Gateway de Pagamento
```
1. payments: Implementa integração
2. backend-api: Adiciona endpoints
3. database: Schema para novo provider
4. testing: Testes E2E do fluxo
5. devops: Secrets e webhooks
```

## Best Practices

### Code Standards
- TypeScript strict mode
- ESLint + Prettier configurados
- Conventional commits
- Branch protection com PR reviews
- Cobertura mínima de 80%

### Documentation
- JSDoc para funções públicas
- README atualizado
- OpenAPI/Swagger para endpoints
- Changelog mantido

### Security
- Validação de inputs
- Sanitização de dados
- Rate limiting apropriado
- Logs sem dados sensíveis
- Secrets em variáveis de ambiente

### Performance
- Lazy loading de módulos
- Índices apropriados no DB
- Cache estratégico
- Paginação em listagens
- Compressão de responses

## Communication Templates

### Task Handoff
```
De: [Agent A]
Para: [Agent B]
Task: [Descrição]
Context: [Informações relevantes]
Dependencies: [O que precisa estar pronto]
Expected Output: [Resultado esperado]
```

### Issue Report
```
Agent: [Nome]
Issue: [Descrição do problema]
Impact: [Crítico/Alto/Médio/Baixo]
Affected Components: [Listagem]
Proposed Solution: [Sugestão]
Needs Input From: [Outros agents]
```

### Review Request
```
Agent: [Nome]
Component: [Módulo/Feature]
Changes: [Resumo das mudanças]
Testing: [Status dos testes]
Review Focus: [Pontos de atenção]
Reviewers Needed: [Agents específicos]
```

## Metrics & KPIs

### Development
- Velocity de features entregues
- Bugs por sprint
- Code coverage %
- Technical debt ratio

### Performance
- API response time p95
- Database query time p95
- Generation success rate
- Uptime %

### Business
- Cost per generation
- Credit consumption accuracy
- Payment success rate
- Subscription retention

## Escalation Path

1. **Technical Issues:** backend-api → devops → external help
2. **Data Issues:** database → backend-api → manual intervention
3. **Payment Issues:** payments → support → provider support
4. **Integration Failures:** integrations → devops → provider status
5. **Security Incidents:** All agents → immediate response → audit

## Regular Sync Points

- **Daily:** Quick status check
- **Weekly:** Sprint planning e retrospectiva
- **Monthly:** Architecture review
- **Quarterly:** Tech debt assessment

## Resources & Documentation

### Internal
- `/CLAUDE.md` - Business rules and architecture
- `/TODO.md` - Current tasks and priorities
- `/.env.example` - Environment variables
- `/docs/` - Technical documentation

### External
- [NestJS Docs](https://docs.nestjs.com)
- [TypeORM Docs](https://typeorm.io)
- [PostgreSQL Docs](https://www.postgresql.org/docs)
- [Stripe API](https://stripe.com/docs/api)
- [Jest Docs](https://jestjs.io/docs)

## Success Criteria

O time será considerado bem-sucedido quando:
1. API funcionando com 99.9% uptime
2. Todas as features core implementadas
3. Cobertura de testes > 80%
4. Performance dentro dos SLAs
5. Zero vulnerabilidades críticas
6. Documentação completa e atualizada