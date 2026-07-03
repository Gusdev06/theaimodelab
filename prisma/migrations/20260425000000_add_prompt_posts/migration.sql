-- CreateTable
CREATE TABLE "prompt_posts" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "caption" TEXT,
    "is_published" BOOLEAN NOT NULL DEFAULT true,
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "copy_count" INTEGER NOT NULL DEFAULT 0,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompt_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_post_slides" (
    "id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "prompt" TEXT NOT NULL,
    "image_url" TEXT NOT NULL,
    "thumbnail_url" TEXT,
    "aspect_ratio" TEXT,
    "generation_type" "GenerationType" NOT NULL DEFAULT 'TEXT_TO_IMAGE',
    "ai_model" TEXT,
    "copy_count" INTEGER NOT NULL DEFAULT 0,
    "use_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompt_post_slides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "prompt_posts_slug_key" ON "prompt_posts"("slug");

-- CreateIndex
CREATE INDEX "prompt_posts_slug_idx" ON "prompt_posts"("slug");

-- CreateIndex
CREATE INDEX "prompt_posts_is_published_created_at_idx" ON "prompt_posts"("is_published", "created_at" DESC);

-- CreateIndex
CREATE INDEX "prompt_post_slides_post_id_order_idx" ON "prompt_post_slides"("post_id", "order");

-- AddForeignKey
ALTER TABLE "prompt_post_slides" ADD CONSTRAINT "prompt_post_slides_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "prompt_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
