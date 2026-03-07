import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  type AccessoryContextLink,
  fetchEngineConfiguredTiers,
  fetchRecommendedProducts,
  formatMoney,
  getTierProgress,
  parseBoolean,
  parseNumber,
  parseTiers,
} from "../lib/discount-widget.server";

const DEFAULT_MAX_RECOMMENDATIONS = 2;
const DEFAULT_NEAR_THRESHOLD_PERCENT = 20;

type CartLinePayload = {
  productId: string;
  variantId: string;
  sku: string;
  handle: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);

  const subtotal = Math.max(0, parseNumber(url.searchParams.get("subtotal"), 0));
  const currency = url.searchParams.get("currency") || "USD";
  const engineTiers = await fetchEngineConfiguredTiers(admin);
  const tiers = engineTiers.length > 0 ? engineTiers : parseTiers(url.searchParams.get("tiers"));

  const maxRecommendations = Math.max(
    0,
    Math.min(
      6,
      Math.floor(
        parseNumber(
          url.searchParams.get("maxRecommendations"),
          DEFAULT_MAX_RECOMMENDATIONS,
        ),
      ),
    ),
  );
  const nearThresholdPercent = Math.max(
    0,
    Math.min(
      100,
      parseNumber(
        url.searchParams.get("nearThresholdPercent"),
        DEFAULT_NEAR_THRESHOLD_PERCENT,
      ),
    ),
  );
  const currentDiscountPercentRaw = parseNumber(
    url.searchParams.get("currentDiscountPercent"),
    -1,
  );
  const currentDiscountPercent =
    Number.isFinite(currentDiscountPercentRaw) && currentDiscountPercentRaw >= 0
      ? Math.max(0, Math.min(100, currentDiscountPercentRaw))
      : null;
  const recommendationsEnabled = parseBoolean(
    url.searchParams.get("recommendationsEnabled"),
    true,
  );
  const xyzHintEnabled = parseBoolean(url.searchParams.get("xyzHintEnabled"), false);
  const xyzHintMessage =
    url.searchParams.get("xyzHintMessage") ||
    "Add qualifying collection items to improve your total discount.";

  const cartLines = parseCartLines(url.searchParams.get("cartLines"));
  const cartProductIds = new Set(
    (url.searchParams.get("cartProductIds") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  for (const line of cartLines) {
    if (line.productId) cartProductIds.add(line.productId);
  }

  const excludedVariantIds = new Set(
    (url.searchParams.get("excludeVariantIds") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const cartVariantIds = new Set(
    (url.searchParams.get("cartVariantIds") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  for (const line of cartLines) {
    if (line.variantId) cartVariantIds.add(line.variantId);
  }
  for (const id of cartVariantIds) {
    excludedVariantIds.add(id);
  }
  const preferredAccessoryProductIds = new Set(
    (url.searchParams.get("preferredAccessoryProductIds") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const preferredAccessoryHandles = new Set(
    (url.searchParams.get("preferredAccessoryHandles") || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const accessoryContext = parseAccessoryContext(url.searchParams.get("accessoryContext"));

  const progress = getTierProgress(
    subtotal,
    tiers,
    nearThresholdPercent,
    currentDiscountPercent ?? undefined,
  );
  const subtotalImpliedTier =
    [...tiers].reverse().find((tier) => subtotal >= tier.targetAmount) ?? null;
  const useCurrentDiscountOverride = Boolean(
    currentDiscountPercent !== null &&
      subtotalImpliedTier &&
      currentDiscountPercent + 0.1 < subtotalImpliedTier.percent,
  );

  const recommendations = recommendationsEnabled
      ? await fetchRecommendedProducts({
          admin,
          subtotal,
          tiers,
          currentTier: progress.currentTier,
          currentDiscountPercent,
          amountRemaining: progress.amountRemaining,
          nextTier: progress.nextTier,
          cartProductIds,
          excludedVariantIds,
          preferredAccessoryProductIds,
          preferredAccessoryHandles,
          accessoryContext,
          currency,
          config: { maxRecommendations, nearThresholdPercent },
        })
    : [];

  const primaryMessage = useCurrentDiscountOverride
    ? progress.nextTier
      ? `Current cart discount: ${formatPercent(currentDiscountPercent!)}. Next bulk tier: ${progress.nextTier.code} (${progress.nextTier.percent}%).`
      : `Current cart discount: ${formatPercent(currentDiscountPercent!)}.`
    : progress.nextTier
      ? progress.amountRemaining > 0
        ? `${formatMoney(progress.amountRemaining, currency)} away from ${progress.nextTier.code} (${progress.nextTier.percent}%)`
        : `Unlocked ${progress.nextTier.code} (${progress.nextTier.percent}%)`
      : progress.currentTier
        ? `You unlocked ${progress.currentTier.code} (${progress.currentTier.percent}%)`
        : "Add items to unlock your first bulk discount";

  const secondaryMessage =
    useCurrentDiscountOverride
      ? "Bulk tiers apply only to qualifying items."
      : xyzHintEnabled && progress.amountRemaining > 0
        ? xyzHintMessage
        : null;

  return Response.json({
    subtotal,
    currency,
    currentDiscountPercent,
    currentTier: progress.currentTier,
    nextTier: progress.nextTier,
    amountRemaining: progress.amountRemaining,
    progressPercent: progress.progressPercent,
    journeyProgressPercent: progress.journeyProgressPercent,
    nearThreshold: progress.nearThreshold,
    recommendations,
    labels: {
      primaryMessage,
      secondaryMessage,
      recommendationHeading:
        progress.nextTier && (progress.amountRemaining > 0 || useCurrentDiscountOverride)
          ? "Recommended to unlock next tier"
          : "Recommended for your cart",
      configSource: engineTiers.length > 0 ? "smart_discount_engine" : "widget_settings",
    },
  });
};

function formatPercent(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const normalized = Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(2);
  return `${normalized}%`;
}

function parseCartLines(raw: string | null): CartLinePayload[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((entry) => {
        const productId = String(entry?.productId || "").trim();
        if (!productId) return null;

        return {
          productId,
          variantId: String(entry?.variantId || "").trim(),
          sku: String(entry?.sku || "").trim(),
          handle: String(entry?.handle || "").trim().toLowerCase(),
        };
      })
      .filter((line): line is CartLinePayload => line !== null);
  } catch {
    return [];
  }
}

function parseAccessoryContext(raw: string | null): AccessoryContextLink[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((entry) => {
        const productId = String(entry?.productId || entry?.p || "").trim();
        const handle = String(entry?.handle || entry?.h || "")
          .trim()
          .toLowerCase();
        const sourceHandle = String(entry?.sourceHandle || entry?.s || "")
          .trim()
          .toLowerCase();

        if (!productId && !handle) return null;
        if (!sourceHandle) return null;

        return {
          productId,
          handle,
          sourceHandle,
        };
      })
      .filter((entry): entry is AccessoryContextLink => entry !== null)
      .slice(0, 80);
  } catch {
    return [];
  }
}
