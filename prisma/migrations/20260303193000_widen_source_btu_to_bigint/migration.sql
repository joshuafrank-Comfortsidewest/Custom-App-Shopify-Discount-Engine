-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_HvacSkuMapping" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "shop" TEXT NOT NULL,
    "sourceSku" TEXT NOT NULL,
    "sourceType" TEXT,
    "sourceBrand" TEXT,
    "sourceSeries" TEXT,
    "sourceSystem" TEXT,
    "sourceBtu" BIGINT,
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
INSERT INTO "new_HvacSkuMapping" (
    "id", "shop", "sourceSku", "sourceType", "sourceBrand", "sourceSeries", "sourceSystem", "sourceBtu", "sourceRefrigerant", "mappedVariantId", "mappedVariantSku", "mappedProductId", "mappedProductTitle", "mappedProductHandle", "mappedProductUrl", "matchStatus", "note", "createdAt", "updatedAt"
)
SELECT
    "id", "shop", "sourceSku", "sourceType", "sourceBrand", "sourceSeries", "sourceSystem", "sourceBtu", "sourceRefrigerant", "mappedVariantId", "mappedVariantSku", "mappedProductId", "mappedProductTitle", "mappedProductHandle", "mappedProductUrl", "matchStatus", "note", "createdAt", "updatedAt"
FROM "HvacSkuMapping";
DROP TABLE "HvacSkuMapping";
ALTER TABLE "new_HvacSkuMapping" RENAME TO "HvacSkuMapping";
CREATE UNIQUE INDEX "HvacSkuMapping_shop_sourceSku_key" ON "HvacSkuMapping"("shop", "sourceSku");
CREATE INDEX "HvacSkuMapping_shop_matchStatus_idx" ON "HvacSkuMapping"("shop", "matchStatus");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
