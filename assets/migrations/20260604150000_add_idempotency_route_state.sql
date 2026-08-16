-- Add durable idempotency and route/window state primitives.

ALTER TABLE "task_queue" ADD COLUMN "idempotency_key" TEXT;

CREATE UNIQUE INDEX "task_queue_type_idempotency_key_key" ON "task_queue"("type", "idempotency_key");

CREATE TABLE "outbound_messages" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "idempotency_key" TEXT NOT NULL,
    "route_key" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "target_platform" TEXT,
    "task_kind" TEXT NOT NULL,
    "article_key" TEXT,
    "synthetic_key" TEXT,
    "payload_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "provider_message_ids" JSONB,
    "segment_results" JSONB,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" INTEGER NOT NULL,
    "updated_at" INTEGER NOT NULL,
    "finished_at" INTEGER
);

CREATE UNIQUE INDEX "outbound_messages_idempotency_key_key" ON "outbound_messages"("idempotency_key");
CREATE INDEX "outbound_messages_target_id_status_idx" ON "outbound_messages"("target_id", "status");
CREATE INDEX "outbound_messages_route_key_task_kind_idx" ON "outbound_messages"("route_key", "task_kind");
CREATE INDEX "outbound_messages_article_key_idx" ON "outbound_messages"("article_key");
CREATE INDEX "outbound_messages_synthetic_key_idx" ON "outbound_messages"("synthetic_key");

CREATE TABLE "aggregation_windows" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "idempotency_key" TEXT NOT NULL,
    "route_key" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "window_start" INTEGER NOT NULL,
    "window_end" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "payload_hash" TEXT,
    "created_at" INTEGER NOT NULL,
    "updated_at" INTEGER NOT NULL,
    "finished_at" INTEGER
);

CREATE UNIQUE INDEX "aggregation_windows_idempotency_key_key" ON "aggregation_windows"("idempotency_key");
CREATE INDEX "aggregation_windows_route_key_mode_status_idx" ON "aggregation_windows"("route_key", "mode", "status");
CREATE INDEX "aggregation_windows_target_id_mode_status_idx" ON "aggregation_windows"("target_id", "mode", "status");

CREATE TABLE "aggregation_items" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "window_id" INTEGER NOT NULL,
    "article_key" TEXT NOT NULL,
    "article_row_id" INTEGER NOT NULL,
    "platform" TEXT NOT NULL,
    "payload" JSONB,
    "created_at" INTEGER NOT NULL,
    CONSTRAINT "aggregation_items_window_id_fkey" FOREIGN KEY ("window_id") REFERENCES "aggregation_windows" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "aggregation_items_window_id_article_key_key" ON "aggregation_items"("window_id", "article_key");
CREATE INDEX "aggregation_items_article_key_idx" ON "aggregation_items"("article_key");

CREATE TABLE "target_health" (
    "target_id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "last_send_status" TEXT,
    "last_provider_code" TEXT,
    "disabled_reason" TEXT,
    "details" JSONB,
    "checked_at" INTEGER NOT NULL,
    "updated_at" INTEGER NOT NULL
);
