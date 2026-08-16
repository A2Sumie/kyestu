-- CreateTable
CREATE TABLE "website_article" (
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
    CONSTRAINT "website_article_ref_fkey" FOREIGN KEY ("ref") REFERENCES "website_article" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "processor_runs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "processor_id" TEXT,
    "action" TEXT NOT NULL,
    "source_type" TEXT,
    "source_ref" TEXT,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "input" JSONB,
    "output" JSONB,
    "error" TEXT,
    "created_at" INTEGER NOT NULL,
    "finished_at" INTEGER
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_task_queue" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" INTEGER NOT NULL,
    "updated_at" INTEGER NOT NULL DEFAULT 0,
    "execute_at" INTEGER NOT NULL,
    "finished_at" INTEGER,
    "last_error" TEXT,
    "result_summary" TEXT,
    "source_ref" TEXT,
    "action_type" TEXT
);
INSERT INTO "new_task_queue" ("created_at", "execute_at", "id", "payload", "status", "type") SELECT "created_at", "execute_at", "id", "payload", "status", "type" FROM "task_queue";
DROP TABLE "task_queue";
ALTER TABLE "new_task_queue" RENAME TO "task_queue";
CREATE INDEX "task_queue_status_execute_at_idx" ON "task_queue"("status", "execute_at");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_website_article_1" ON "website_article"("id");
Pragma writable_schema=0;

-- CreateIndex
CREATE INDEX "website_by_timestamp" ON "website_article"("created_at" DESC);

-- CreateIndex
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_website_article_2" ON "website_article"("a_id");
Pragma writable_schema=0;

-- CreateIndex
CREATE INDEX "processor_runs_processor_id_created_at_idx" ON "processor_runs"("processor_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "processor_runs_source_ref_created_at_idx" ON "processor_runs"("source_ref", "created_at" DESC);
