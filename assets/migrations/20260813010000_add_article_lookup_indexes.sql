-- RedefineTables not required: plain index additions.
CREATE INDEX "twitter_by_uid_ts" ON "twitter_article"("u_id", "created_at" DESC);
CREATE INDEX "twitter_by_url" ON "twitter_article"("url");
CREATE INDEX "instagram_by_uid_ts" ON "instagram_article"("u_id", "created_at" DESC);
CREATE INDEX "instagram_by_url" ON "instagram_article"("url");
CREATE INDEX "tiktok_by_uid_ts" ON "tiktok_article"("u_id", "created_at" DESC);
CREATE INDEX "tiktok_by_url" ON "tiktok_article"("url");
CREATE INDEX "youtube_by_uid_ts" ON "youtube_article"("u_id", "created_at" DESC);
CREATE INDEX "youtube_by_url" ON "youtube_article"("url");
CREATE INDEX "website_by_uid_ts" ON "website_article"("u_id", "created_at" DESC);
CREATE INDEX "website_by_url" ON "website_article"("url");
CREATE INDEX "task_queue_type_status_exec" ON "task_queue"("type", "status", "execute_at");
CREATE INDEX "task_queue_status_updated" ON "task_queue"("status", "updated_at");
