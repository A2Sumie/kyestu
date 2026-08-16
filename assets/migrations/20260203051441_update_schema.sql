/*
  Warnings:

  - The primary key for the `forward_by` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - Added the required column `platform` to the `forward_by` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "twitter_article" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "a_id" TEXT NOT NULL,
    "u_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "created_at" INTEGER NOT NULL,
    "content" TEXT,
    "translation" TEXT,
    "translated_by" TEXT,
    "url" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ref" INTEGER,
    "has_media" BOOLEAN NOT NULL,
    "media" JSONB,
    "extra" JSONB,
    "u_avatar" TEXT,
    CONSTRAINT "twitter_article_ref_fkey" FOREIGN KEY ("ref") REFERENCES "twitter_article" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "instagram_article" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "a_id" TEXT NOT NULL,
    "u_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "created_at" INTEGER NOT NULL,
    "content" TEXT,
    "translation" TEXT,
    "translated_by" TEXT,
    "url" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ref" INTEGER,
    "has_media" BOOLEAN NOT NULL,
    "media" JSONB,
    "extra" JSONB,
    "u_avatar" TEXT,
    CONSTRAINT "instagram_article_ref_fkey" FOREIGN KEY ("ref") REFERENCES "instagram_article" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "tiktok_article" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "a_id" TEXT NOT NULL,
    "u_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "created_at" INTEGER NOT NULL,
    "content" TEXT,
    "translation" TEXT,
    "translated_by" TEXT,
    "url" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ref" INTEGER,
    "has_media" BOOLEAN NOT NULL,
    "media" JSONB,
    "extra" JSONB,
    "u_avatar" TEXT,
    CONSTRAINT "tiktok_article_ref_fkey" FOREIGN KEY ("ref") REFERENCES "tiktok_article" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "youtube_article" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "a_id" TEXT NOT NULL,
    "u_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "created_at" INTEGER NOT NULL,
    "content" TEXT,
    "translation" TEXT,
    "translated_by" TEXT,
    "url" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ref" INTEGER,
    "has_media" BOOLEAN NOT NULL,
    "media" JSONB,
    "extra" JSONB,
    "u_avatar" TEXT,
    CONSTRAINT "youtube_article_ref_fkey" FOREIGN KEY ("ref") REFERENCES "youtube_article" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "task_queue" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" INTEGER NOT NULL,
    "execute_at" INTEGER NOT NULL
);

INSERT INTO "twitter_article" (
    "id",
    "a_id",
    "u_id",
    "username",
    "created_at",
    "content",
    "translation",
    "translated_by",
    "url",
    "type",
    "ref",
    "has_media",
    "media",
    "extra",
    "u_avatar"
)
SELECT
    "id",
    "a_id",
    "u_id",
    "username",
    "created_at",
    "content",
    "translation",
    "translated_by",
    "url",
    "type",
    "ref",
    "has_media",
    "media",
    "extra",
    "u_avatar"
FROM "crawler_article"
WHERE "platform" = 1;

INSERT INTO "instagram_article" (
    "id",
    "a_id",
    "u_id",
    "username",
    "created_at",
    "content",
    "translation",
    "translated_by",
    "url",
    "type",
    "ref",
    "has_media",
    "media",
    "extra",
    "u_avatar"
)
SELECT
    "id",
    "a_id",
    "u_id",
    "username",
    "created_at",
    "content",
    "translation",
    "translated_by",
    "url",
    "type",
    "ref",
    "has_media",
    "media",
    "extra",
    "u_avatar"
FROM "crawler_article"
WHERE "platform" = 2;

INSERT INTO "tiktok_article" (
    "id",
    "a_id",
    "u_id",
    "username",
    "created_at",
    "content",
    "translation",
    "translated_by",
    "url",
    "type",
    "ref",
    "has_media",
    "media",
    "extra",
    "u_avatar"
)
SELECT
    "id",
    "a_id",
    "u_id",
    "username",
    "created_at",
    "content",
    "translation",
    "translated_by",
    "url",
    "type",
    "ref",
    "has_media",
    "media",
    "extra",
    "u_avatar"
FROM "crawler_article"
WHERE "platform" = 3;

INSERT INTO "youtube_article" (
    "id",
    "a_id",
    "u_id",
    "username",
    "created_at",
    "content",
    "translation",
    "translated_by",
    "url",
    "type",
    "ref",
    "has_media",
    "media",
    "extra",
    "u_avatar"
)
SELECT
    "id",
    "a_id",
    "u_id",
    "username",
    "created_at",
    "content",
    "translation",
    "translated_by",
    "url",
    "type",
    "ref",
    "has_media",
    "media",
    "extra",
    "u_avatar"
FROM "crawler_article"
WHERE "platform" = 4;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_forward_by" (
    "ref_id" INTEGER NOT NULL,
    "platform" TEXT NOT NULL,
    "bot_id" TEXT NOT NULL,
    "task_type" TEXT NOT NULL,

    PRIMARY KEY ("ref_id", "platform", "bot_id", "task_type")
);
INSERT INTO "new_forward_by" ("bot_id", "ref_id", "task_type", "platform")
SELECT
    fb."bot_id",
    fb."ref_id",
    fb."task_type",
    COALESCE(CAST(ca."platform" AS TEXT), 'legacy_unknown')
FROM "forward_by" fb
LEFT JOIN "crawler_article" ca ON ca."id" = fb."ref_id";
DROP TABLE "forward_by";
ALTER TABLE "new_forward_by" RENAME TO "forward_by";
CREATE INDEX "bot_id_index" ON "forward_by"("bot_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- DropIndex
DROP INDEX "sqlite_autoindex_crawler_article_2";

-- DropIndex
DROP INDEX "platform_by_timestamp";

-- DropIndex
DROP INDEX "platform_index";

-- DropIndex
DROP INDEX "sqlite_autoindex_crawler_article_1";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "crawler_article";
PRAGMA foreign_keys=on;

-- CreateIndex
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_twitter_article_1" ON "twitter_article"("id");
Pragma writable_schema=0;

-- CreateIndex
CREATE INDEX "twitter_by_timestamp" ON "twitter_article"("created_at" DESC);

-- CreateIndex
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_twitter_article_2" ON "twitter_article"("a_id");
Pragma writable_schema=0;

-- CreateIndex
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_instagram_article_1" ON "instagram_article"("id");
Pragma writable_schema=0;

-- CreateIndex
CREATE INDEX "instagram_by_timestamp" ON "instagram_article"("created_at" DESC);

-- CreateIndex
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_instagram_article_2" ON "instagram_article"("a_id");
Pragma writable_schema=0;

-- CreateIndex
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_tiktok_article_1" ON "tiktok_article"("id");
Pragma writable_schema=0;

-- CreateIndex
CREATE INDEX "tiktok_by_timestamp" ON "tiktok_article"("created_at" DESC);

-- CreateIndex
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_tiktok_article_2" ON "tiktok_article"("a_id");
Pragma writable_schema=0;

-- CreateIndex
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_youtube_article_1" ON "youtube_article"("id");
Pragma writable_schema=0;

-- CreateIndex
CREATE INDEX "youtube_by_timestamp" ON "youtube_article"("created_at" DESC);

-- CreateIndex
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_youtube_article_2" ON "youtube_article"("a_id");
Pragma writable_schema=0;

-- CreateIndex
CREATE INDEX "task_queue_status_execute_at_idx" ON "task_queue"("status", "execute_at");
