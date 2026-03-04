-- CreateTable
CREATE TABLE "HvacSkuMapping" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "sourceSku" TEXT NOT NULL,
    "sourceType" TEXT,
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

-- CreateIndex
CREATE UNIQUE INDEX "HvacSkuMapping_shop_sourceSku_key" ON "HvacSkuMapping"("shop", "sourceSku");

-- CreateIndex
CREATE INDEX "HvacSkuMapping_shop_matchStatus_idx" ON "HvacSkuMapping"("shop", "matchStatus");
