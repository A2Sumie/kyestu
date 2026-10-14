-- Inbound QQ event ledger (app/qq-ingress): one row per normalized event ever
-- accepted, keyed by a stable dedupe key so webhook re-deliveries can never
-- re-trigger reactions. `status` tracks the dispatch lifecycle
-- (received -> dispatching -> ok/error/skipped, plus bad for unparseable
-- payloads); the recovery pass re-dispatches rows stuck in `received` /
-- stale `dispatching` and treats rows without a qq_messages mirror partner as
-- missed history.

CREATE TABLE "qq_inbound_events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "dedupe_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "scope" TEXT,
    "group_id" INTEGER,
    "user_id" INTEGER,
    "self_id" INTEGER,
    "message_id" INTEGER,
    "event_time" INTEGER NOT NULL DEFAULT 0,
    "text" TEXT,
    "recovered" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "raw" JSONB,
    "created_at" INTEGER NOT NULL
);

CREATE UNIQUE INDEX "qq_inbound_events_dedupe_key_key" ON "qq_inbound_events"("dedupe_key");
CREATE INDEX "qq_inbound_events_scope_message_id_idx" ON "qq_inbound_events"("scope", "message_id");
CREATE INDEX "qq_inbound_events_status_idx" ON "qq_inbound_events"("status");
