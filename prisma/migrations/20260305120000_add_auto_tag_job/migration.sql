-- CreateTable
CREATE TABLE "AutoTagJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "discountNodeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "mode" TEXT NOT NULL,
    "targetTag" TEXT,
    "scheduledUndoAt" TEXT,
    "inputSkusJson" TEXT NOT NULL,
    "matchedProductsJson" TEXT NOT NULL,
    "changesJson" TEXT NOT NULL DEFAULT '[]',
    "errorsJson" TEXT NOT NULL DEFAULT '[]',
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "changedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedProtectedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "AutoTagJob_shop_discountNodeId_status_idx"
ON "AutoTagJob"("shop", "discountNodeId", "status");

-- CreateIndex
CREATE INDEX "AutoTagJob_shop_createdAt_idx"
ON "AutoTagJob"("shop", "createdAt");
