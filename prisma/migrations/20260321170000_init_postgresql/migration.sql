-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HvacSkuMapping" (
    "id" SERIAL NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HvacSkuMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoTagJob" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoTagJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HvacSkuMapping_shop_sourceSku_key" ON "HvacSkuMapping"("shop", "sourceSku");

-- CreateIndex
CREATE INDEX "HvacSkuMapping_shop_matchStatus_idx" ON "HvacSkuMapping"("shop", "matchStatus");

-- CreateIndex
CREATE INDEX "AutoTagJob_shop_discountNodeId_status_idx" ON "AutoTagJob"("shop", "discountNodeId", "status");

-- CreateIndex
CREATE INDEX "AutoTagJob_shop_createdAt_idx" ON "AutoTagJob"("shop", "createdAt");
