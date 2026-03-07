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

export type AccessoryContextLink = {
  productId: string;
  handle: string;
  sourceHandle: string;
};

export type WidgetRecommendationVariant = {
  variantId: string;
  variantTitle: string;
  price: number;
  estimatedNetPrice: number;
  estimatedSavings: number;
  projectedTierCode: string | null;
  projectedPercent: number;
  unlocksNextTier: boolean;
  effectivelyFree: boolean;
  benefitLabel: string;
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
  recommendationType: string;
  recommendedFor: string[];
  variants: WidgetRecommendationVariant[];
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
  currentDiscountPercent?: number,
): TierProgress {
  const safeSubtotal = Number.isFinite(subtotal) ? Math.max(0, subtotal) : 0;
  const safeCurrentDiscountPercent = Number.isFinite(currentDiscountPercent)
    ? clamp(Number(currentDiscountPercent), 0, 100)
    : null;

  const currentTierBySubtotal =
    [...tiers].reverse().find((tier) => safeSubtotal >= tier.targetAmount) ?? null;
  const nextTierBySubtotal = tiers.find((tier) => safeSubtotal < tier.targetAmount) ?? null;

  let currentTier = currentTierBySubtotal;
  let nextTier = nextTierBySubtotal;

  if (safeCurrentDiscountPercent !== null) {
    currentTier =
      [...tiers].reverse().find((tier) => safeCurrentDiscountPercent >= tier.percent) ?? null;
    nextTier = tiers.find((tier) => safeCurrentDiscountPercent < tier.percent) ?? null;
  }

  const amountRemaining = nextTier
    ? Math.max(0, roundMoney(nextTier.targetAmount - safeSubtotal))
    : 0;

  const progressPercent =
    safeCurrentDiscountPercent !== null
      ? nextTier
        ? clamp((safeCurrentDiscountPercent / nextTier.percent) * 100, 0, 100)
        : 100
      : nextTier
        ? clamp((safeSubtotal / nextTier.targetAmount) * 100, 0, 100)
        : 100;

  const maxTierPercent = tiers.length > 0 ? tiers[tiers.length - 1].percent : 100;
  const journeyProgressPercent =
    safeCurrentDiscountPercent !== null
      ? clamp((safeCurrentDiscountPercent / maxTierPercent) * 100, 0, 100)
      : getTierJourneyProgress(safeSubtotal, tiers);

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
  currentDiscountPercent,
  nextTier,
  amountRemaining,
  cartProductIds,
  excludedVariantIds,
  preferredAccessoryProductIds,
  preferredAccessoryHandles,
  accessoryContext,
  currency,
  config,
}: {
  admin: AdminClientLike;
  subtotal: number;
  tiers: Tier[];
  currentTier: Tier | null;
  currentDiscountPercent?: number | null;
  nextTier: Tier | null;
  amountRemaining: number;
  cartProductIds: Set<string>;
  excludedVariantIds: Set<string>;
  preferredAccessoryProductIds: Set<string>;
  preferredAccessoryHandles: Set<string>;
  accessoryContext: AccessoryContextLink[];
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

    const hasAccessoryHints =
      preferredAccessoryProductIds.size > 0 ||
      preferredAccessoryHandles.size > 0 ||
      accessoryContext.length > 0;
    const poolTargetSize = Math.max(config.maxRecommendations * 10, 40);
    const fallbackProducts =
      hasAccessoryHints || preferredProducts.length >= poolTargetSize
        ? []
        : await fetchFallbackProducts(admin, poolTargetSize - preferredProducts.length);

    const products = dedupeProducts([...preferredProducts, ...fallbackProducts]);
    const preferredProductIdSet = new Set(
      Array.from(preferredAccessoryProductIds).map((id) => String(id).trim()),
    );
    const preferredHandleSet = new Set(
      Array.from(preferredAccessoryHandles).map((handle) => normalizeHandle(handle)),
    );
    const sourceMap = buildAccessorySourceMaps(accessoryContext);

    const currentPercent = Number.isFinite(currentDiscountPercent)
      ? clamp(Number(currentDiscountPercent), 0, 100)
      : currentTier?.percent ?? 0;
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

      const relatedCartItems = getRelatedCartItemsForProduct({
        productId: productNumericId,
        handle: product.handle,
        sourceMap,
      });
      const isPreferredProduct =
        Boolean(productNumericId && preferredProductIdSet.has(productNumericId)) ||
        preferredHandleSet.has(normalizeHandle(product.handle)) ||
        relatedCartItems.length > 0;

      const maxVariantPrice = roundMoney(
        isPreferredProduct ? basePriceCap * 2.2 : basePriceCap,
      );

      const variantCandidates: Array<{
        score: number;
        variantId: string;
        variantTitle: string;
        option: WidgetRecommendationVariant;
      }> = [];

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
          relatedCartMatchCount: relatedCartItems.length,
        });

        if (score <= 0) continue;

        variantCandidates.push({
          score,
          variantId: variantNumericId ?? variant.id,
          variantTitle: variant.title,
          option: {
            variantId: variantNumericId ?? variant.id,
            variantTitle: variant.title,
            price: roundedVariantPrice,
            estimatedNetPrice: preview.estimatedNetPrice,
            estimatedSavings: preview.estimatedSavings,
            projectedTierCode: preview.projectedTier?.code ?? null,
            projectedPercent: preview.projectedPercent,
            unlocksNextTier: preview.unlocksNextTier,
            effectivelyFree: preview.effectivelyFree,
            benefitLabel: buildBenefitLabel({
              nextTier,
              preview,
              amountRemaining,
              currency,
            }),
          },
        });
      }

      if (variantCandidates.length === 0) {
        continue;
      }

      variantCandidates.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.option.estimatedNetPrice - b.option.estimatedNetPrice;
      });

      const variants = variantCandidates.slice(0, 4).map((candidate) => candidate.option);
      const best = variantCandidates[0];
      const recommendationType = classifyRecommendationType(product.title, product.handle);

      const recommendation: WidgetRecommendation = {
          productId: productNumericId ?? product.id,
          variantId: best.variantId,
          title: product.title,
          variantTitle: best.variantTitle,
          price: best.option.price,
          compareAtPrice: best.option.price,
          estimatedNetPrice: best.option.estimatedNetPrice,
          estimatedSavings: best.option.estimatedSavings,
          projectedTierCode: best.option.projectedTierCode,
          projectedPercent: best.option.projectedPercent,
          unlocksNextTier: best.option.unlocksNextTier,
          effectivelyFree: best.option.effectivelyFree,
          source: isPreferredProduct ? "cart_accessory_match" : "fallback",
          imageUrl: product.featuredImage?.url ?? null,
          productUrl: product.onlineStoreUrl,
          benefitLabel: best.option.benefitLabel,
          recommendationType,
          recommendedFor: relatedCartItems,
          variants,
        };

      const diversityBoost =
        recommendationType === "Line set"
          ? 0
          : recommendationType === "Other"
            ? 6
            : 18;
      const bestForProduct: RecommendationCandidate = {
        score: roundMoney(best.score + diversityBoost),
        recommendation,
      };

      if (bestForProduct) {
        candidates.push(bestForProduct);
      }
    }

    const selected = selectDiverseRecommendations(candidates, config.maxRecommendations);

    return selected.map((candidate) => candidate.recommendation);
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

function buildAccessorySourceMaps(accessoryContext: AccessoryContextLink[]): {
  byProductId: Map<string, Set<string>>;
  byHandle: Map<string, Set<string>>;
} {
  const byProductId = new Map<string, Set<string>>();
  const byHandle = new Map<string, Set<string>>();

  for (const item of accessoryContext) {
    const productId = String(item.productId || "").trim();
    const handle = normalizeHandle(item.handle);
    const sourceHandle = normalizeHandle(item.sourceHandle);
    if (!sourceHandle) continue;

    const sourceLabel = humanizeHandle(sourceHandle);

    if (productId) {
      if (!byProductId.has(productId)) byProductId.set(productId, new Set<string>());
      byProductId.get(productId)!.add(sourceLabel);
    }

    if (handle) {
      if (!byHandle.has(handle)) byHandle.set(handle, new Set<string>());
      byHandle.get(handle)!.add(sourceLabel);
    }
  }

  return { byProductId, byHandle };
}

function getRelatedCartItemsForProduct({
  productId,
  handle,
  sourceMap,
}: {
  productId: string | null;
  handle: string;
  sourceMap: {
    byProductId: Map<string, Set<string>>;
    byHandle: Map<string, Set<string>>;
  };
}): string[] {
  const labels = new Set<string>();
  const normalizedHandle = normalizeHandle(handle);

  if (productId && sourceMap.byProductId.has(productId)) {
    for (const label of sourceMap.byProductId.get(productId) ?? []) {
      labels.add(label);
    }
  }

  if (normalizedHandle && sourceMap.byHandle.has(normalizedHandle)) {
    for (const label of sourceMap.byHandle.get(normalizedHandle) ?? []) {
      labels.add(label);
    }
  }

  return Array.from(labels).slice(0, 3);
}

function selectDiverseRecommendations(
  candidates: RecommendationCandidate[],
  maxRecommendations: number,
): RecommendationCandidate[] {
  const ranked = [...candidates].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.recommendation.estimatedNetPrice !== b.recommendation.estimatedNetPrice) {
      return a.recommendation.estimatedNetPrice - b.recommendation.estimatedNetPrice;
    }
    return a.recommendation.title.localeCompare(b.recommendation.title);
  });

  if (ranked.length <= maxRecommendations) return ranked;

  const selected: RecommendationCandidate[] = [];
  const usedTypes = new Set<string>();

  for (const candidate of ranked) {
    if (selected.length >= maxRecommendations) break;
    const type = candidate.recommendation.recommendationType || "Other";
    if (usedTypes.has(type)) continue;
    selected.push(candidate);
    usedTypes.add(type);
  }

  for (const candidate of ranked) {
    if (selected.length >= maxRecommendations) break;
    if (selected.includes(candidate)) continue;
    selected.push(candidate);
  }

  return selected;
}

function classifyRecommendationType(title: string, handle: string): string {
  const haystack = `${String(title || "")} ${String(handle || "")}`.toLowerCase();

  if (/(line\s*set|pre[-\s]?flared|flare|copper|line[\s-]?hide)/.test(haystack)) {
    return "Line set";
  }
  if (/(mount|bracket|stand|pad|wall mount)/.test(haystack)) {
    return "Mounting";
  }
  if (/(disconnect|surge|wire|whip|breaker|electrical|voltage)/.test(haystack)) {
    return "Electrical";
  }
  if (/(drain|pump|condensate|trap|float switch)/.test(haystack)) {
    return "Drain";
  }
  if (/(cover|guard|protector|shield|snow|hail)/.test(haystack)) {
    return "Protection";
  }
  if (/(remote|thermostat|controller|wifi|module|sensor)/.test(haystack)) {
    return "Control";
  }
  if (/(filter|clean|coil|maintenance|kit|seal|insulation)/.test(haystack)) {
    return "Maintenance";
  }

  return "Other";
}

function humanizeHandle(handle: string): string {
  const value = normalizeHandle(handle);
  if (!value) return "current cart item";

  return value
    .split("-")
    .filter(Boolean)
    .slice(0, 8)
    .map((segment) =>
      segment.length <= 3
        ? segment.toUpperCase()
        : `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`,
    )
    .join(" ");
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
  relatedCartMatchCount,
}: {
  amountRemaining: number;
  nextTier: Tier | null;
  currentPercent: number;
  variantPrice: number;
  preview: PricingPreview;
  isPreferredProduct: boolean;
  relatedCartMatchCount: number;
}): number {
  let score = 0;

  if (isPreferredProduct) {
    score += 320;
  }
  if (relatedCartMatchCount > 0) {
    score += 140 + Math.min(relatedCartMatchCount, 3) * 45;
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
