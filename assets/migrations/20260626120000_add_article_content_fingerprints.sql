-- Forwarding-time content fingerprint dedup ledger.

CREATE TABLE "article_content_fingerprints" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "scope" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "article_key" TEXT,
    "platform" TEXT,
    "article_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "created_at" INTEGER NOT NULL,
    "updated_at" INTEGER NOT NULL
);

CREATE UNIQUE INDEX "article_content_fingerprints_scope_target_fingerprint_key" ON "article_content_fingerprints"("scope", "target_id", "fingerprint");
CREATE INDEX "article_content_fingerprints_target_id_status_idx" ON "article_content_fingerprints"("target_id", "status");
CREATE INDEX "article_content_fingerprints_fingerprint_idx" ON "article_content_fingerprints"("fingerprint");
