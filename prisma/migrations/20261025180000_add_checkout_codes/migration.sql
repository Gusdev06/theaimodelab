-- Códigos de checkout extras por marca e por conta do gateway (Funvmake, troca de conta CPF → CNPJ).
-- Só CREATE: nenhuma tabela existente muda.

-- CreateTable
CREATE TABLE "checkout_codes" (
    "id" TEXT NOT NULL,
    "gateway" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "brand" TEXT NOT NULL DEFAULT 'taml',
    "currency" TEXT NOT NULL,
    "checkout_url" TEXT,
    "account" TEXT,
    "note" TEXT,
    "plan_id" TEXT,
    "credit_package_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkout_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "checkout_codes_plan_id_idx" ON "checkout_codes"("plan_id");

-- CreateIndex
CREATE INDEX "checkout_codes_credit_package_id_idx" ON "checkout_codes"("credit_package_id");

-- CreateIndex
CREATE INDEX "checkout_codes_brand_currency_idx" ON "checkout_codes"("brand", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "checkout_codes_gateway_code_key" ON "checkout_codes"("gateway", "code");

-- AddForeignKey
ALTER TABLE "checkout_codes" ADD CONSTRAINT "checkout_codes_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checkout_codes" ADD CONSTRAINT "checkout_codes_credit_package_id_fkey" FOREIGN KEY ("credit_package_id") REFERENCES "credit_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Cada código aponta para um plano OU um pacote, nunca os dois nem nenhum.
ALTER TABLE "checkout_codes" ADD CONSTRAINT "checkout_codes_one_target" CHECK (("plan_id" IS NULL) <> ("credit_package_id" IS NULL));
