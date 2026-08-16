-- CreateTable
CREATE TABLE "service_state" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updated_at" INTEGER NOT NULL DEFAULT 0
);
