-- Local mirror of the bridge message-store (SnowLuma get_msg / get_*_msg_history).
-- Used for history backfill after outage gaps and receipt reconciliation.

CREATE TABLE "qq_messages" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "scope" TEXT NOT NULL,
    "message_id" INTEGER NOT NULL,
    "real_id" INTEGER,
    "sent_at" INTEGER NOT NULL DEFAULT 0,
    "sender_id" INTEGER,
    "message_type" TEXT,
    "text" TEXT,
    "raw" JSONB,
    "created_at" INTEGER NOT NULL
);

CREATE UNIQUE INDEX "qq_messages_scope_message_id_key" ON "qq_messages"("scope", "message_id");
CREATE INDEX "qq_messages_scope_sent_at_idx" ON "qq_messages"("scope", "sent_at");
