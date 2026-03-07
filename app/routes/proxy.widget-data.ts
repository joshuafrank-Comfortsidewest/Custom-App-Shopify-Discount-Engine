import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  type AccessoryContextLink,
  applyShadowCartExactPricing,
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
  title: string;
  variantTitle: string;
  quantity: number;
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
  const cartBtuValues = extractCartBtuValues(cartLines);

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

  let recommendations = recommendationsEnabled
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
          cartBtuValues,
          currency,
          config: { maxRecommendations, nearThresholdPercent },
        })
    : [];

  recommendations = await applyShadowCartExactPricing({
    shop: url.searchParams.get("shop"),
    currency,
    cartLines: cartLines.map((line) => ({
      variantId: line.variantId,
      quantity: line.quantity,
    })),
    recommendations,
  });
  const exactPreviewCount = recommendations.filter(
    (item) => item.pricingSource === "exact",
  ).length;

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
  const pricingDisclaimer =
    exactPreviewCount > 0
      ? `Exact preview on ${exactPreviewCount} pick${exactPreviewCount > 1 ? "s" : ""}. Final discount is determined at cart/checkout.`
      : "Estimated preview only. Final discount is determined at cart/checkout.";

  return Response.json({
    subtotal,
    currency,
    tiers,
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
      pricingDisclaimer,
      configSource: engineTiers.length > 0 ? "smart_discount_engine" : "widget_settings",
      exactPreviewCount,
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
          title: String(entry?.title || "").trim(),
          variantTitle: String(entry?.variantTitle || "").trim(),
          quantity: Math.max(1, Math.floor(parseNumber(String(entry?.quantity ?? "1"), 1))),
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

function extractCartBtuValues(lines: CartLinePayload[]): number[] {
  const values = new Set<number>();
  for (const line of lines) {
    const source = `${line.sku} ${line.title} ${line.variantTitle}`;
    for (const value of extractBtuValuesFromText(source)) {
      values.add(value);
    }
  }
  return Array.from(values).sort((a, b) => a - b);
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
