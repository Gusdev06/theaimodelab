-- Planos anuais: mesma tabela, billing_interval='year' e base_plan_slug apontando
-- pro mensal irmão. Créditos continuam em credits_per_month (liberados mês a mês).
ALTER TABLE "plans" ADD COLUMN "billing_interval" TEXT NOT NULL DEFAULT 'month';
ALTER TABLE "plans" ADD COLUMN "base_plan_slug" TEXT;
