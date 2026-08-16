-- CreateTable
CREATE TABLE "media_hashes" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "platform" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "a_id" TEXT NOT NULL DEFAULT '',
    "created_at" INTEGER NOT NULL
);

-- CreateIndex
CREATE INDEX "media_hashes_hash_idx" ON "media_hashes"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "platform_hash_unique" ON "media_hashes"("platform", "hash");
