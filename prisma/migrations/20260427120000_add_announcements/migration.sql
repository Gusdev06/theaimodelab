-- CreateTable
CREATE TABLE "announcements" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "variant" TEXT,
    "badge" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "image_url" TEXT,
    "cta_label" TEXT,
    "cta_action" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "announcements_slug_key" ON "announcements"("slug");

-- CreateIndex
CREATE INDEX "announcements_is_active_sort_order_idx" ON "announcements"("is_active", "sort_order");

-- Seed existing announcements (idempotent — uses ON CONFLICT)
INSERT INTO "announcements" (id, slug, variant, badge, title, description, image_url, cta_label, cta_action, is_active, sort_order, updated_at)
VALUES
  (
    gen_random_uuid()::text,
    'gpt-image-2-launch-2026-04',
    'openai',
    'NOVO MODELO',
    'Ouvimos seu feedback e trouxemos o GPT Image 2 ao The AI Model Lab!',
    'O novo modelo de imagem da OpenAI já está disponível no painel de gerar imagem. Suporta texto-pra-imagem e edição com referências, em 1K, 2K e 4K.',
    'https://cdn.theaimodelab.com.br/storage/v1/object/public/ai-generations/admin_assets/landing/ea2bc984-8267-48ab-bf11-e56cc8ffaa2e/theaimodelab-ai__30_.jpg',
    'Quero testar',
    '{"type":"open-image-panel"}'::jsonb,
    true,
    0,
    NOW()
  ),
  (
    gen_random_uuid()::text,
    'weekly-claim-launch-2026-04',
    'feature',
    'NOVO BENEFÍCIO',
    'Quartou com The AI Model Lab! 4 vídeos grátis toda quarta-feira',
    'Agora, todo assinante tem a exclusividade de resgatar 4 vídeos no AI Model Lab Fast a cada quarta-feira. É só clicar em "Resgatar bônus" lá na barra de cima — sem desculpinha de fim de mês.',
    NULL,
    'Saber mais',
    '{"type":"open-weekly-claim"}'::jsonb,
    true,
    1,
    NOW()
  )
ON CONFLICT (slug) DO NOTHING;
