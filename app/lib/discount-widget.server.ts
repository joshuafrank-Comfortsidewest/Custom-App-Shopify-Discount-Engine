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

export type CartLineForPreview = {
  variantId: string;
  quantity: number;
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
  pricingSource: "exact" | "estimated";
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
  recommendedForBtu: number[];
  variants: WidgetRecommendationVariant[];
  pricingSource: "exact" | "estimated";
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
const SHADOW_CART_CACHE_TTL_MS = 90 * 1000;
const SHADOW_CART_MAX_PREVIEW_ITEMS = 10;
const SHADOW_CART_MAX_PREVIEW_VARIANTS = 4;
const SHADOW_CART_CACHE = new Map<string, { expiresAt: number; subtotal: number }>();
const RECOMMENDATION_TYPE_ORDER = [
  "Line set covers",
  "Line Sets",
  "Wall Brackets / Condenser Pad",
  "Heat Kit",
  "Cleaning Kit",
  "Couplers",
  "Thermostat",
  "Conduit Cables",
  "Disconnect Box",
  "Rubber Feet Mounting Set",
  "Ground Stands",
  "Accessories",
] as const;
const RECOMMENDATION_TYPE_PRODUCT_IDS: Record<string, Set<string>> = {
  "Line set covers": new Set([
    "7420475277427",
    "7784329478259",
    "8004649517171",
    "8004667080819",
    "8053617295475",
  ]),
  "Line Sets": new Set([
    "8056140103795",
    "7347732283507",
    "8014110228595",
    "8014232748147",
    "8014250672243",
    "8014258929779",
    "8014268104819",
    "8052349042803",
    "8048835068019",
    "8014321451123",
    "7871035375731",
    "7871312920691",
    "7347983646835",
    "7871070437491",
    "7871408996467",
    "7346828476531",
    "7871160057971",
    "7871417024627",
    "7346841485427",
    "7347980533875",
    "7871217598579",
    "8037632344179",
    "8036342694003",
    "8036336730227",
    "8036351639667",
    "8036331913331",
    "8055997857907",
    "8056020729971",
  ]),
  "Wall Brackets / Condenser Pad": new Set([
    "8111079882867",
    "7855248081011",
    "8004737138803",
    "8004764401779",
    "7850596696179",
    "8004698243187",
    "7420483698803",
  ]),
  "Heat Kit": new Set([
    "7932186591347",
    "7932195995763",
    "7932199600243",
    "7932201205875",
    "7932202352755",
    "7992329470067",
    "7992329994355",
    "7992330780787",
    "7992328749171",
    "7842623127667",
    "7842622210163",
    "7812784914547",
    "7842621751411",
    "8014096859251",
    "8014095286387",
    "8014094467187",
    "8014092697715",
    "8014080573555",
  ]),
  "Cleaning Kit": new Set(["7855129690227"]),
  Couplers: new Set(["7855235006579", "7855238676595"]),
  Thermostat: new Set(["7800311185523", "8056167891059", "8056169431155", "8062486544499"]),
  "Conduit Cables": new Set(["7850574938227"]),
  "Disconnect Box": new Set(["7850581426291", "8004678910067", "7850578018419"]),
  "Rubber Feet Mounting Set": new Set(["8004578836595"]),
  "Ground Stands": new Set(["8004777836659", "7784261976179", "7784222031987"]),
};

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
  cartBtuValues,
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
  cartBtuValues: number[];
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
      const recommendationType = classifyRecommendationType(
        product.title,
        product.handle,
        productNumericId,
      );
      const typeNeedsBtuMatching = isBtuSensitiveType(recommendationType);
      const isPreferredProduct =
        Boolean(productNumericId && preferredProductIdSet.has(productNumericId)) ||
        preferredHandleSet.has(normalizeHandle(product.handle)) ||
        relatedCartItems.length > 0;
      const preferredCapMultiplier =
        recommendationType === "Line Sets"
          ? 4.5
          : recommendationType === "Line set covers"
            ? 3.2
            : 2.2;
      const preferredMinCap =
        recommendationType === "Line Sets"
          ? 350
          : recommendationType === "Line set covers"
            ? 120
            : 0;

      const maxVariantPrice = roundMoney(
        isPreferredProduct
          ? Math.max(basePriceCap * preferredCapMultiplier, preferredMinCap)
          : basePriceCap,
      );

      const variantCandidates: Array<{
        score: number;
        variantId: string;
        variantTitle: string;
        matchedBtu: number[];
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
        const btuFit = getBtuFit({
          cartBtuValues,
          text: `${product.title} ${variant.title} ${product.handle}`,
        });
        if (
          typeNeedsBtuMatching &&
          cartBtuValues.length > 0 &&
          btuFit.targetValues.length > 0 &&
          btuFit.matchedValues.length === 0
        ) {
          continue;
        }

        const score = scoreRecommendation({
          amountRemaining,
          nextTier,
          currentPercent,
          variantPrice: roundedVariantPrice,
          preview,
          isPreferredProduct,
          relatedCartMatchCount: relatedCartItems.length,
          btuMatchCount: btuFit.matchedValues.length,
        });

        if (score <= 0) continue;

        variantCandidates.push({
          score,
          variantId: variantNumericId ?? variant.id,
          variantTitle: variant.title,
          matchedBtu: btuFit.matchedValues,
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
            pricingSource: "estimated",
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

      const variants = variantCandidates.slice(0, 6).map((candidate) => candidate.option);
      const best = variantCandidates[0];

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
          recommendedForBtu: best.matchedBtu,
          variants,
          pricingSource: best.option.pricingSource,
        };

      const diversityBoost =
        recommendationType === "Line Sets"
          ? 0
          : recommendationType === "Accessories"
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

export async function applyShadowCartExactPricing({
  shop,
  currency,
  cartLines,
  recommendations,
}: {
  shop: string | null;
  currency: string;
  cartLines: CartLineForPreview[];
  recommendations: WidgetRecommendation[];
}): Promise<WidgetRecommendation[]> {
  const normalizedShop = String(shop || "").trim().toLowerCase();
  if (!normalizedShop || recommendations.length === 0 || cartLines.length === 0) {
    return recommendations;
  }

  const storefrontToken = String(process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN || "").trim();
  if (!storefrontToken) {
    return recommendations;
  }

  const cartSeed = cartLines
    .map((line) => ({
      variantGid: toVariantGid(line.variantId),
      quantity: Math.max(1, Math.floor(Number(line.quantity || 1))),
    }))
    .filter((line): line is { variantGid: string; quantity: number } => Boolean(line.variantGid));
  if (cartSeed.length === 0) {
    return recommendations;
  }

  const storefrontApiVersion =
    String(process.env.SHOPIFY_STOREFRONT_API_VERSION || "").trim() || "2025-10";
  const cartHash = getShadowCartHash(cartSeed);
  const baseSubtotal = await getShadowCartSubtotal({
    shop: normalizedShop,
    apiVersion: storefrontApiVersion,
    storefrontToken,
    lines: cartSeed,
    cacheKey: `${normalizedShop}|${cartHash}|base`,
  });
  if (!Number.isFinite(baseSubtotal) || baseSubtotal < 0) {
    return recommendations;
  }

  const enriched = recommendations.map((item) => ({
    ...item,
    pricingSource: item.pricingSource ?? "estimated",
    variants: Array.isArray(item.variants) ? [...item.variants] : [],
  }));

  for (let i = 0; i < Math.min(enriched.length, SHADOW_CART_MAX_PREVIEW_ITEMS); i += 1) {
    const recommendation = enriched[i];
    const variantsToPreview = recommendation.variants.slice(0, SHADOW_CART_MAX_PREVIEW_VARIANTS);
    const previewResults = await Promise.all(
      variantsToPreview.map(async (variant) => {
        const variantGid = toVariantGid(variant.variantId);
        if (!variantGid) {
          return { variantId: variant.variantId, exactSubtotal: Number.NaN };
        }

        const scenarioLines = [...cartSeed, { variantGid, quantity: 1 }];
        const scenarioSubtotal = await getShadowCartSubtotal({
          shop: normalizedShop,
          apiVersion: storefrontApiVersion,
          storefrontToken,
          lines: scenarioLines,
          cacheKey: `${normalizedShop}|${cartHash}|${variantGid}|1`,
        });

        return {
          variantId: variant.variantId,
          exactSubtotal: scenarioSubtotal,
        };
      }),
    );

    for (const result of previewResults) {
      if (!Number.isFinite(result.exactSubtotal) || result.exactSubtotal < baseSubtotal) continue;

      const variantIndex = recommendation.variants.findIndex(
        (entry) => String(entry.variantId) === String(result.variantId),
      );
      if (variantIndex < 0) continue;

      const variantPrice = recommendation.variants[variantIndex].price;
      const exactNet = roundMoney(Math.max(0, result.exactSubtotal - baseSubtotal));
      const exactSavings = roundMoney(Math.max(0, variantPrice - exactNet));
      const exactFree = exactNet <= 0.01;
      recommendation.variants[variantIndex] = {
        ...recommendation.variants[variantIndex],
        estimatedNetPrice: exactNet,
        estimatedSavings: exactSavings,
        effectivelyFree: exactFree,
        benefitLabel: `Exact preview with current cart: ${formatMoney(exactNet, currency)}`,
        pricingSource: "exact",
      };
    }

    const selectedVariant = recommendation.variants.find(
      (variant) => String(variant.variantId) === String(recommendation.variantId),
    );
    if (!selectedVariant) continue;

    recommendation.estimatedNetPrice = selectedVariant.estimatedNetPrice;
    recommendation.estimatedSavings = selectedVariant.estimatedSavings;
    recommendation.effectivelyFree = selectedVariant.effectivelyFree;
    recommendation.benefitLabel = selectedVariant.benefitLabel;
    recommendation.pricingSource = selectedVariant.pricingSource;
  }

  return enriched;
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

function classifyRecommendationType(
  title: string,
  handle: string,
  productId: string | null,
): string {
  const pid = String(productId || "").trim();
  if (pid) {
    for (const type of RECOMMENDATION_TYPE_ORDER) {
      const set = RECOMMENDATION_TYPE_PRODUCT_IDS[type];
      if (set && set.has(pid)) return type;
    }
  }

  const haystack = `${String(title || "")} ${String(handle || "")}`.toLowerCase();

  if (/(conduit|cable|wire\s*kit|control\s*wire|signal\s*wire)/.test(haystack)) {
    return "Conduit Cables";
  }
  if (/(heat\s*kit|heater\s*kit|aux\s*heat|strip\s*heat)/.test(haystack)) {
    return "Heat Kit";
  }
  if (/(disconnect|disc\s*box|breaker\s*box|fused\s*disconnect|non[-\s]?fused)/.test(haystack)) {
    return "Disconnect Box";
  }
  if (/(line[\s-]?set[\s-]?(cover|duct)|line[\s-]?hide|decorative[\s-]?line)/.test(haystack)) {
    return "Line set covers";
  }
  if (/(rubber\s*feet|rubber\s*foot|vibration|anti[-\s]?vibration|mounting\s*set)/.test(haystack)) {
    return "Rubber Feet Mounting Set";
  }
  if (/(ground\s*stand|floor\s*stand|mini\s*split\s*stand)/.test(haystack)) {
    return "Ground Stands";
  }
  if (/(wall\s*bracket|wall\s*mount|condenser\s*pad|\bpad\b|bracket)/.test(haystack)) {
    return "Wall Brackets / Condenser Pad";
  }
  if (/(line\s*set|pre[-\s]?flared|flare|copper)/.test(haystack)) {
    return "Line Sets";
  }

  return "Accessories";
}

function isBtuSensitiveType(type: string): boolean {
  return type === "Line Sets" || type === "Line set covers";
}

function getBtuFit({
  cartBtuValues,
  text,
}: {
  cartBtuValues: number[];
  text: string;
}): { targetValues: number[]; matchedValues: number[] } {
  const targets = extractBtuValuesFromText(text);
  if (targets.length === 0 || cartBtuValues.length === 0) {
    return { targetValues: targets, matchedValues: [] };
  }

  const matched = targets.filter((value) => cartBtuValues.some((cartBtu) => cartBtu === value));
  return { targetValues: targets, matchedValues: matched };
}

function extractBtuValuesFromText(raw: string): number[] {
  const text = String(raw || "").toUpperCase();
  if (!text) return [];

  const values = new Set<number>();
  const add = (num: number) => {
    if (!Number.isFinite(num)) return;
    const normalized = Math.round(num);
    if (normalized < 6000 || normalized > 60000) return;
    values.add(normalized);
  };

  for (const match of text.matchAll(/\b(\d{1,2})\s*K\b/g)) {
    add(Number(match[1]) * 1000);
  }

  for (const match of text.matchAll(/\b(\d{1,2}(?:,\d{3})|\d{4,5})\s*BTU\b/g)) {
    add(Number(String(match[1]).replaceAll(",", "")));
  }

  for (const match of text.matchAll(/\b(\d{4,5})\s*[-/]\s*(\d{4,5})\s*BTU\b/g)) {
    add(Number(match[1]));
    add(Number(match[2]));
  }

  return Array.from(values).sort((a, b) => a - b);
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

async function getShadowCartSubtotal({
  shop,
  apiVersion,
  storefrontToken,
  lines,
  cacheKey,
}: {
  shop: string;
  apiVersion: string;
  storefrontToken: string;
  lines: Array<{ variantGid: string; quantity: number }>;
  cacheKey: string;
}): Promise<number> {
  const now = Date.now();
  const cached = SHADOW_CART_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.subtotal;
  }

  const subtotal = await requestShadowCartSubtotal({
    shop,
    apiVersion,
    storefrontToken,
    lines,
  });
  if (!Number.isFinite(subtotal)) {
    return Number.NaN;
  }

  SHADOW_CART_CACHE.set(cacheKey, {
    expiresAt: now + SHADOW_CART_CACHE_TTL_MS,
    subtotal,
  });

  if (SHADOW_CART_CACHE.size > 500) {
    for (const [key, entry] of SHADOW_CART_CACHE.entries()) {
      if (entry.expiresAt <= now) SHADOW_CART_CACHE.delete(key);
      if (SHADOW_CART_CACHE.size <= 350) break;
    }
  }

  return subtotal;
}

async function requestShadowCartSubtotal({
  shop,
  apiVersion,
  storefrontToken,
  lines,
}: {
  shop: string;
  apiVersion: string;
  storefrontToken: string;
  lines: Array<{ variantGid: string; quantity: number }>;
}): Promise<number> {
  const endpoint = `https://${shop}/api/${apiVersion}/graphql.json`;
  const payload = {
    query: `#graphql
      mutation ShadowCartPreview($lines: [CartLineInput!]) {
        cartCreate(input: { lines: $lines }) {
          cart {
            cost {
              subtotalAmount {
                amount
                currencyCode
              }
            }
          }
          userErrors {
            message
          }
        }
      }
    `,
    variables: {
      lines: lines.map((line) => ({
        merchandiseId: line.variantGid,
        quantity: line.quantity,
      })),
    },
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": storefrontToken,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return Number.NaN;

    const json = (await response.json()) as {
      data?: {
        cartCreate?: {
          cart?: {
            cost?: {
              subtotalAmount?: {
                amount?: string;
              };
            };
          };
          userErrors?: Array<{ message?: string }>;
        };
      };
    };

    const amount = Number(json.data?.cartCreate?.cart?.cost?.subtotalAmount?.amount ?? Number.NaN);
    return Number.isFinite(amount) ? roundMoney(amount) : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

function getShadowCartHash(lines: Array<{ variantGid: string; quantity: number }>): string {
  return [...lines]
    .sort((a, b) => a.variantGid.localeCompare(b.variantGid))
    .map((line) => `${line.variantGid}:${line.quantity}`)
    .join("|");
}

function toVariantGid(idOrGid: string): string | null {
  const raw = String(idOrGid || "").trim();
  if (!raw) return null;
  if (raw.startsWith("gid://shopify/ProductVariant/")) return raw;
  const numeric = extractNumericId(raw);
  return numeric ? `gid://shopify/ProductVariant/${numeric}` : null;
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
  const projectedItemNet = roundMoney(
    Math.max(0, variantPrice * (1 - projectedPercent / 100)),
  );
  const estimatedNetPrice = projectedItemNet;
  const estimatedSavings = roundMoney(Math.max(0, variantPrice - projectedItemNet));
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
    effectivelyFree: projectedItemNet <= 0.01,
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
  btuMatchCount,
}: {
  amountRemaining: number;
  nextTier: Tier | null;
  currentPercent: number;
  variantPrice: number;
  preview: PricingPreview;
  isPreferredProduct: boolean;
  relatedCartMatchCount: number;
  btuMatchCount: number;
}): number {
  let score = 0;

  if (isPreferredProduct) {
    score += 320;
  }
  if (relatedCartMatchCount > 0) {
    score += 140 + Math.min(relatedCartMatchCount, 3) * 45;
  }
  if (btuMatchCount > 0) {
    score += 120 + Math.min(btuMatchCount, 2) * 35;
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
  if (preview.unlocksNextTier && preview.projectedTier) {
    return `Can unlock ${preview.projectedTier.code} with qualifying items`;
  }

  if (nextTier && amountRemaining > 0 && preview.remainingAfterAdd > 0) {
    return `Add this and be ${formatMoney(preview.remainingAfterAdd, currency)} away from ${nextTier.code}`;
  }

  if (preview.projectedTier) {
    return `May qualify for ${preview.projectedTier.code} discount tier`;
  }

  return "Final discount is calculated at checkout";
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
