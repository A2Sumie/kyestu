-- Track cross-platform video pairing so high-frequency teaser posts can be held and merged into one Bilibili multipart upload.

CREATE TABLE "video_pairings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "pairing_key" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "source_article_key" TEXT NOT NULL,
    "source_article_id" INTEGER,
    "source_platform" TEXT NOT NULL,
    "source_a_id" TEXT NOT NULL,
    "source_u_id" TEXT,
    "source_username" TEXT,
    "source_created_at" INTEGER NOT NULL,
    "join_platform" TEXT NOT NULL,
    "target_article_key" TEXT,
    "target_article_id" INTEGER,
    "target_video_id" TEXT,
    "target_profile_url" TEXT,
    "target_u_id" TEXT,
    "target_username" TEXT,
    "teaser_media" JSONB,
    "merge_result" JSONB,
    "expires_at" INTEGER NOT NULL,
    "created_at" INTEGER NOT NULL,
    "updated_at" INTEGER NOT NULL,
    "finished_at" INTEGER
);

CREATE UNIQUE INDEX "video_pairings_pairing_key_key" ON "video_pairings"("pairing_key");
CREATE UNIQUE INDEX "video_pairings_target_id_source_article_key_key" ON "video_pairings"("target_id", "source_article_key");
CREATE INDEX "video_pairings_status_expires_at_idx" ON "video_pairings"("status", "expires_at");
CREATE INDEX "video_pairings_target_id_join_platform_status_idx" ON "video_pairings"("target_id", "join_platform", "status");
CREATE INDEX "video_pairings_target_video_id_idx" ON "video_pairings"("target_video_id");
CREATE INDEX "video_pairings_target_article_key_idx" ON "video_pairings"("target_article_key");
