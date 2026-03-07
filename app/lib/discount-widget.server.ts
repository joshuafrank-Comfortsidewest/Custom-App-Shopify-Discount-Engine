type Tier = {
  code: string;
  percent: number;
  targetAmount: number;
};

type ProductVariantNode = {
  id: string;
  title: string;
  price: string;
  availableForSale: boolean;
  inventoryQuantity: number | null;
};

type ProductNode = {
  id: string;
  title: string;
  handle: string;
  onlineStoreUrl: string | null;
  featuredImage: {
    url: string;
    altText: string | null;
  } | null;
  variants: {
    nodes: ProductVariantNode[];
  };
};

type RecommenderConfig = {
  maxRecommendations: number;
  nearThresholdPercent: number;
};

type TierProgress = {
  currentTier: Tier | null;
  nextTier: Tier | null;
  amountRemaining: number;
  progressPercent: number;
  journeyProgressPercent: number;
  nearThreshold: boolean;
};

export type WidgetRecommendation = {
  productId: string;
  variantId: string;
  title: string;
  variantTitle: string;
  price: number;
  compareAtPrice: number;
  estimatedNetPrice: number;
  estimatedSavings: number;
  projectedTierCode: string | null;
  projectedPercent: number;
  unlocksNextTier: boolean;
  effectivelyFree: boolean;
  source: "cart_accessory_match" | "fallback";
  imageUrl: string | null;
  productUrl: string | null;
  benefitLabel: string;
};

type PricingPreview = {
  projectedTier: Tier | null;
  projectedPercent: number;
  remainingAfterAdd: number;
  estimatedNetPrice: number;
  estimatedSavings: number;
  unlocksNextTier: boolean;
  effectivelyFree: boolean;
};

type RecommendationCandidate = {
  score: number;
  recommendation: WidgetRecommendation;
};

const DEFAULT_TIERS = "100:5,250:10,400:13,600:15";

type EngineConfigTierPayload = {
  toggles?: {
    bulk_enabled?: boolean;
  };
  bulk5_min?: number;
  bulk10_min?: number;
  bulk13_min?: number;
  bulk15_min?: number;
  bulk5_percent?: number;
  bulk10_percent?: number;
  bulk13_percent?: number;
  bulk15_percent?: number;
};

export function parseTiers(rawTiers: string | null | undefined): Tier[] {
  const tiers = (rawTiers || DEFAULT_TIERS)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const parts = entry.split(":").map((part) => part.trim());

      if (parts.length === 2) {
        const [targetAmountRaw, percentRaw] = parts;
        const targetAmount = Number(targetAmountRaw);
        const percent = Number(percentRaw);
        if (!Number.isFinite(targetAmount) || !Number.isFinite(percent)) {
          return null;
        }
        return {
          code: `BULK${Math.round(percent)}`,
          percent,
          targetAmount,
        };
      }

      if (parts.length === 3) {
        const [code, targetAmountRaw, percentRaw] = parts;
        const targetAmount = Number(targetAmountRaw);
        const percent = Number(percentRaw);
        if (!code || !Number.isFinite(targetAmount) || !Number.isFinite(percent)) {
          return null;
        }
        return {
          code,
          percent,
          targetAmount,
        };
      }

      return null;
    })
    .filter((tier): tier is Tier => tier !== null && tier.targetAmount > 0)
    .sort((a, b) => a.targetAmount - b.targetAmount);

  return tiers.length > 0 ? tiers : parseTiers(DEFAULT_TIERS);
}

export function parseEngineConfigTiers(rawConfig: string | null | undefined): Tier[] {
  if (!rawConfig) return [];

  try {
    const parsed = JSON.parse(rawConfig) as EngineConfigTierPayload;
    const bulkEnabled = parsed?.toggles?.bulk_enabled ?? true;
    if (!bulkEnabled) return [];

    const candidates: Tier[] = [
      {
        code: "BULK5",
        targetAmount: Number(parsed.bulk5_min),
        percent: Number(parsed.bulk5_percent),
      },
      {
        code: "BULK10",
        targetAmount: Number(parsed.bulk10_min),
        percent: Number(parsed.bulk10_percent),
      },
      {
        code: "BULK13",
        targetAmount: Number(parsed.bulk13_min),
        percent: Number(parsed.bulk13_percent),
      },
      {
        code: "BULK15",
        targetAmount: Number(parsed.bulk15_min),
        percent: Number(parsed.bulk15_percent),
      },
    ].filter(
      (tier) =>
        Number.isFinite(tier.targetAmount) &&
        Number.isFinite(tier.percent) &&
        tier.targetAmount > 0 &&
        tier.percent > 0,
    );

    return candidates.sort((a, b) => a.targetAmount - b.targetAmount);
  } catch {
    return [];
  }
}

export async function fetchEngineConfiguredTiers(admin: AdminClientLike): Promise<Tier[]> {
  if (!admin) return [];

  const response = await admin.graphql(
    `#graphql
      query DiscountEngineConfig($first: Int!) {
        discountNodes(first: $first, query: "status:active method:automatic") {
          nodes {
            metafield(namespace: "smart_discount_engine", key: "config") {
              value
            }
          }
        }
      }
    `,
    { variables: { first: 25 } },
  );

  if (!response.ok) return [];

  const json = (await response.json()) as {
    data?: {
      discountNodes?: {
        nodes?: Array<{
          metafield?: {
            value?: string | null;
          } | null;
        }>;
      };
    };
  };

  const nodes = json.data?.discountNodes?.nodes ?? [];
  for (const node of nodes) {
    const tiers = parseEngineConfigTiers(node.metafield?.value ?? null);
    if (tiers.length > 0) return tiers;
  }

  return [];
}

export function getTierProgress(
  subtotal: number,
  tiers: Tier[],
  nearThresholdPercent: number,
): TierProgress {
  const safeSubtotal = Number.isFinite(subtotal) ? Math.max(0, subtotal) : 0;
  const currentTier =
    [...tiers].reverse().find((tier) => safeSubtotal >= tier.targetAmount) ?? null;
  const nextTier = tiers.find((tier) => safeSubtotal < tier.targetAmount) ?? null;
  const amountRemaining = nextTier
    ? Math.max(0, roundMoney(nextTier.targetAmount - safeSubtotal))
    : 0;

  const progressPercent = nextTier
    ? clamp((safeSubtotal / nextTier.targetAmount) * 100, 0, 100)
    : 100;
  const journeyProgressPercent = getTierJourneyProgress(safeSubtotal, tiers);

  const gapBase = nextTier?.targetAmount ?? 0;
  const nearThreshold =
    Boolean(nextTier) &&
    amountRemaining > 0 &&
    gapBase > 0 &&
    amountRemaining <= (gapBase * nearThresholdPercent) / 100;

  return {
    currentTier,
    nextTier,
    amountRemaining,
    progressPercent: roundMoney(progressPercent),
    journeyProgressPercent: roundMoney(journeyProgressPercent),
    nearThreshold,
  };
}

export async function fetchRecommendedProducts({
  admin,
  subtotal,
  tiers,
  currentTier,
  nextTier,
  amountRemaining,
  cartProductIds,
  excludedVariantIds,
  preferredAccessoryProductIds,
  preferredAccessoryHandles,
  currency,
  config,
}: {
  admin: AdminClientLike;
  subtotal: number;
  tiers: Tier[];
  currentTier: Tier | null;
  nextTier: Tier | null;
  amountRemaining: number;
  cartProductIds: Set<string>;
  excludedVariantIds: Set<string>;
  preferredAccessoryProductIds: Set<string>;
  preferredAccessoryHandles: Set<string>;
  currency: string;
  config: RecommenderConfig;
}): Promise<WidgetRecommendation[]> {
  if (!admin || config.maxRecommendations <= 0 || tiers.length === 0) {
    return [];
  }

  if (!nextTier && !currentTier) {
    return [];
  }

  try {
    const preferredProducts = await fetchPreferredProducts({
      admin,
      productIds: preferredAccessoryProductIds,
      handles: preferredAccessoryHandles,
    });

    const poolTargetSize = Math.max(config.maxRecommendations * 10, 40);
    const fallbackProducts =
      preferredProducts.length >= poolTargetSize
        ? []
        : await fetchFallbackProducts(admin, poolTargetSize - preferredProducts.length);

    const products = dedupeProducts([...preferredProducts, ...fallbackProducts]);
    const preferredProductIdSet = new Set(
      Array.from(preferredAccessoryProductIds).map((id) => String(id).trim()),
    );
    const preferredHandleSet = new Set(
      Array.from(preferredAccessoryHandles).map((handle) => normalizeHandle(handle)),
    );

    const currentPercent = currentTier?.percent ?? 0;
    const basePriceCap = getBasePriceCap({
      subtotal,
      amountRemaining,
      nextTier,
      nearThresholdPercent: config.nearThresholdPercent,
    });

    const candidates: RecommendationCandidate[] = [];

    for (const product of products) {
      const productNumericId = extractNumericId(product.id);
      if (productNumericId && cartProductIds.has(productNumericId)) {
        continue;
      }

      const isPreferredProduct =
        Boolean(productNumericId && preferredProductIdSet.has(productNumericId)) ||
        preferredHandleSet.has(normalizeHandle(product.handle));

      const maxVariantPrice = roundMoney(
        isPreferredProduct ? basePriceCap * 2.2 : basePriceCap,
      );

      let bestForProduct: RecommendationCandidate | null = null;

      for (const variant of product.variants.nodes) {
        if (!variant.availableForSale) continue;
        if (variant.inventoryQuantity !== null && variant.inventoryQuantity <= 0) continue;

        const variantNumericId = extractNumericId(variant.id);
        if (
          (variantNumericId && excludedVariantIds.has(variantNumericId)) ||
          excludedVariantIds.has(variant.id)
        ) {
          continue;
        }

        const variantPrice = Number(variant.price);
        if (!Number.isFinite(variantPrice) || variantPrice <= 0 || variantPrice > maxVariantPrice) {
          continue;
        }

        const roundedVariantPrice = roundMoney(variantPrice);
        const preview = calculatePricingPreview({
          subtotal,
          variantPrice: roundedVariantPrice,
          tiers,
          currentPercent,
          nextTier,
        });

        const score = scoreRecommendation({
          amountRemaining,
          nextTier,
          currentPercent,
          variantPrice: roundedVariantPrice,
          preview,
          isPreferredProduct,
        });

        if (score <= 0) continue;

        const recommendation: WidgetRecommendation = {
          productId: productNumericId ?? product.id,
          variantId: variantNumericId ?? variant.id,
          title: product.title,
          variantTitle: variant.title,
          price: roundedVariantPrice,
          compareAtPrice: roundedVariantPrice,
          estimatedNetPrice: preview.estimatedNetPrice,
          estimatedSavings: preview.estimatedSavings,
          projectedTierCode: preview.projectedTier?.code ?? null,
          projectedPercent: preview.projectedPercent,
          unlocksNextTier: preview.unlocksNextTier,
          effectivelyFree: preview.effectivelyFree,
          source: isPreferredProduct ? "cart_accessory_match" : "fallback",
          imageUrl: product.featuredImage?.url ?? null,
          productUrl: product.onlineStoreUrl,
          benefitLabel: buildBenefitLabel({
            nextTier,
            preview,
            amountRemaining,
            currency,
          }),
        };

        if (!bestForProduct || score > bestForProduct.score) {
          bestForProduct = { score, recommendation };
        }
      }

      if (bestForProduct) {
        candidates.push(bestForProduct);
      }
    }

    return candidates
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.recommendation.estimatedNetPrice !== b.recommendation.estimatedNetPrice) {
          return a.recommendation.estimatedNetPrice - b.recommendation.estimatedNetPrice;
        }
        return a.recommendation.title.localeCompare(b.recommendation.title);
      })
      .slice(0, config.maxRecommendations)
      .map((candidate) => candidate.recommendation);
  } catch {
    return [];
  }
}

export function formatMoney(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(roundMoney(amount));
}

export function parseBoolean(value: string | null, defaultValue = false): boolean {
  if (value === null) return defaultValue;
  return value === "true" || value === "1";
}

export function parseNumber(value: string | null, defaultValue: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

async function fetchPreferredProducts({
  admin,
  productIds,
  handles,
}: {
  admin: AdminClientLike;
  productIds: Set<string>;
  handles: Set<string>;
}): Promise<ProductNode[]> {
  const byIds = await fetchProductsByIds(admin, productIds);
  const byHandles = await fetchProductsByHandles(admin, handles);
  return dedupeProducts([...byIds, ...byHandles]);
}

async function fetchProductsByIds(
  admin: AdminClientLike,
  productIds: Set<string>,
): Promise<ProductNode[]> {
  const ids = Array.from(productIds)
    .map((value) => String(value).trim())
    .filter((value) => /^\d+$/.test(value))
    .slice(0, 80)
    .map((id) => `gid://shopify/Product/${id}`);

  if (!admin || ids.length === 0) return [];

  const response = await admin.graphql(
    `#graphql
      query DiscountProgressProductsByIds($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product {
            id
            title
            handle
            onlineStoreUrl
            featuredImage {
              url
              altText
            }
            variants(first: 6) {
              nodes {
                id
                title
                price
                availableForSale
                inventoryQuantity
              }
            }
          }
        }
      }
    `,
    { variables: { ids } },
  );

  if (!response.ok) return [];

  const json = (await response.json()) as {
    data?: {
      nodes?: Array<ProductNode | null>;
    };
  };

  const nodes = json.data?.nodes ?? [];
  return nodes.filter((node): node is ProductNode => isProductNode(node));
}

async function fetchProductsByHandles(
  admin: AdminClientLike,
  handles: Set<string>,
): Promise<ProductNode[]> {
  const sanitizedHandles = Array.from(handles)
    .map((handle) => normalizeHandle(handle))
    .filter(Boolean)
    .slice(0, 40);

  if (!admin || sanitizedHandles.length === 0) return [];

  const query = sanitizedHandles.map((handle) => `handle:${handle}`).join(" OR ");
  const response = await admin.graphql(
    `#graphql
      query DiscountProgressProductsByHandles($first: Int!, $query: String!) {
        products(first: $first, query: $query) {
          nodes {
            id
            title
            handle
            onlineStoreUrl
            featuredImage {
              url
              altText
            }
            variants(first: 6) {
              nodes {
                id
                title
                price
                availableForSale
                inventoryQuantity
              }
            }
          }
        }
      }
    `,
    {
      variables: {
        first: Math.max(20, sanitizedHandles.length),
        query,
      },
    },
  );

  if (!response.ok) return [];

  const json = (await response.json()) as {
    data?: {
      products?: {
        nodes?: ProductNode[];
      };
    };
  };

  return (json.data?.products?.nodes ?? []).filter((node) => isProductNode(node));
}

async function fetchFallbackProducts(
  admin: AdminClientLike,
  first: number,
): Promise<ProductNode[]> {
  if (!admin || first <= 0) return [];

  const response = await admin.graphql(
    `#graphql
      query DiscountProgressProducts($first: Int!) {
        products(first: $first, query: "status:active total_inventory:>0") {
          nodes {
            id
            title
            handle
            onlineStoreUrl
            featuredImage {
              url
              altText
            }
            variants(first: 6) {
              nodes {
                id
                title
                price
                availableForSale
                inventoryQuantity
              }
            }
          }
        }
      }
    `,
    { variables: { first: Math.max(30, Math.min(120, first + 20)) } },
  );

  if (!response.ok) return [];

  const json = (await response.json()) as {
    data?: {
      products?: {
        nodes?: ProductNode[];
      };
    };
  };

  return (json.data?.products?.nodes ?? []).filter((node) => isProductNode(node));
}

function calculatePricingPreview({
  subtotal,
  variantPrice,
  tiers,
  currentPercent,
  nextTier,
}: {
  subtotal: number;
  variantPrice: number;
  tiers: Tier[];
  currentPercent: number;
  nextTier: Tier | null;
}): PricingPreview {
  const subtotalAfterAdd = roundMoney(subtotal + variantPrice);
  const projectedTier =
    [...tiers].reverse().find((tier) => subtotalAfterAdd >= tier.targetAmount) ?? null;
  const projectedPercent = projectedTier?.percent ?? currentPercent;
  const oldTotalAfterDiscount = roundMoney(subtotal * (1 - currentPercent / 100));
  const newTotalAfterDiscount = roundMoney(
    subtotalAfterAdd * (1 - projectedPercent / 100),
  );
  const incrementalCost = roundMoney(newTotalAfterDiscount - oldTotalAfterDiscount);
  const estimatedNetPrice = roundMoney(Math.max(0, incrementalCost));
  const estimatedSavings = roundMoney(Math.max(0, variantPrice - incrementalCost));
  const remainingAfterAdd = nextTier
    ? roundMoney(Math.max(0, nextTier.targetAmount - subtotalAfterAdd))
    : 0;
  const unlocksNextTier = Boolean(
    nextTier && subtotal < nextTier.targetAmount && subtotalAfterAdd >= nextTier.targetAmount,
  );

  return {
    projectedTier,
    projectedPercent,
    remainingAfterAdd,
    estimatedNetPrice,
    estimatedSavings,
    unlocksNextTier,
    effectivelyFree: incrementalCost <= 0,
  };
}

function scoreRecommendation({
  amountRemaining,
  nextTier,
  currentPercent,
  variantPrice,
  preview,
  isPreferredProduct,
}: {
  amountRemaining: number;
  nextTier: Tier | null;
  currentPercent: number;
  variantPrice: number;
  preview: PricingPreview;
  isPreferredProduct: boolean;
}): number {
  let score = 0;

  if (isPreferredProduct) {
    score += 320;
  }

  if (nextTier && amountRemaining > 0) {
    const distance = Math.abs(amountRemaining - variantPrice);
    score += Math.max(0, 220 - distance * 8);
    if (preview.unlocksNextTier) score += 260;
    if (preview.remainingAfterAdd === 0) score += 120;
  } else {
    score += 40;
  }

  if (preview.projectedPercent > currentPercent) {
    score += (preview.projectedPercent - currentPercent) * 45;
  }

  if (preview.effectivelyFree) {
    score += 240;
  }

  score += Math.max(0, preview.estimatedSavings) * 3;
  score -= variantPrice * 0.25;

  return roundMoney(score);
}

function buildBenefitLabel({
  nextTier,
  preview,
  amountRemaining,
  currency,
}: {
  nextTier: Tier | null;
  preview: PricingPreview;
  amountRemaining: number;
  currency: string;
}): string {
  if (preview.effectivelyFree) {
    if (preview.unlocksNextTier && preview.projectedTier) {
      return `Effectively free if you unlock ${preview.projectedTier.code}`;
    }
    return "Effectively free with your current discount";
  }

  if (preview.unlocksNextTier && preview.projectedTier) {
    return `Unlock ${preview.projectedTier.code} and pay about ${formatMoney(preview.estimatedNetPrice, currency)} net`;
  }

  if (nextTier && amountRemaining > 0 && preview.remainingAfterAdd > 0) {
    return `Add this and be ${formatMoney(preview.remainingAfterAdd, currency)} away from ${nextTier.code}`;
  }

  if (preview.projectedTier) {
    return `Projected ${preview.projectedTier.code}: ${preview.projectedPercent}% discount`;
  }

  return `Estimated net ${formatMoney(preview.estimatedNetPrice, currency)}`;
}

function getBasePriceCap({
  subtotal,
  amountRemaining,
  nextTier,
  nearThresholdPercent,
}: {
  subtotal: number;
  amountRemaining: number;
  nextTier: Tier | null;
  nearThresholdPercent: number;
}): number {
  if (nextTier && amountRemaining > 0) {
    return Math.max(20, amountRemaining * (1 + nearThresholdPercent / 100));
  }

  return Math.max(80, subtotal * 0.2);
}

function dedupeProducts(products: ProductNode[]): ProductNode[] {
  const seen = new Set<string>();
  const deduped: ProductNode[] = [];

  for (const product of products) {
    if (!isProductNode(product)) continue;
    const key = extractNumericId(product.id) ?? product.id;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(product);
  }

  return deduped;
}

function isProductNode(node: ProductNode | null | undefined): node is ProductNode {
  return Boolean(node?.id && node?.title && node?.variants?.nodes);
}

function extractNumericId(idOrGid: string): string | null {
  const raw = String(idOrGid || "").trim();
  if (/^\d+$/.test(raw)) return raw;
  const match = raw.match(/\/(\d+)$/);
  return match ? match[1] : null;
}

function normalizeHandle(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getTierJourneyProgress(subtotal: number, tiers: Tier[]): number {
  if (tiers.length === 0) return 0;

  const n = tiers.length;
  const segment = 100 / n;
  const firstTarget = tiers[0].targetAmount;

  if (subtotal <= firstTarget) {
    return clamp((subtotal / firstTarget) * segment, 0, segment);
  }

  for (let i = 0; i < n - 1; i += 1) {
    const current = tiers[i];
    const next = tiers[i + 1];
    if (subtotal >= current.targetAmount && subtotal < next.targetAmount) {
      const base = (i + 1) * segment;
      const span = next.targetAmount - current.targetAmount;
      if (span <= 0) return base;
      const inSegment = ((subtotal - current.targetAmount) / span) * segment;
      return clamp(base + inSegment, 0, 100);
    }
  }

  return 100;
}

type AdminClientLike =
  | {
      graphql: (
        query: string,
        options?: { variables?: Record<string, unknown> },
      ) => Promise<Response>;
    }
  | undefined;
