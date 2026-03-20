-- CreateTable
CREATE TABLE "HvacSkuMapping" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "sourceSku" TEXT NOT NULL,
    "sourceType" TEXT,
    "sourceBrand" TEXT,
    "sourceSeries" TEXT,
    "sourceSystem" TEXT,
    "sourceBtu" INTEGER,
    "sourceRefrigerant" TEXT,
    "mappedVariantId" TEXT,
    "mappedVariantSku" TEXT,
    "mappedProductId" TEXT,
    "mappedProductTitle" TEXT,
    "mappedProductHandle" TEXT,
    "mappedProductUrl" TEXT,
    "matchStatus" TEXT NOT NULL DEFAULT 'unmapped',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

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
CREATE INDEX "HvacSkuMapping_shop_matchStatus_idx" ON "HvacSkuMapping"("shop", "matchStatus");

-- CreateIndex
CREATE UNIQUE INDEX "HvacSkuMapping_shop_sourceSku_key" ON "HvacSkuMapping"("shop", "sourceSku");

-- CreateIndex
CREATE INDEX "AutoTagJob_shop_discountNodeId_status_idx" ON "AutoTagJob"("shop", "discountNodeId", "status");

-- CreateIndex
CREATE INDEX "AutoTagJob_shop_createdAt_idx" ON "AutoTagJob"("shop", "createdAt");
