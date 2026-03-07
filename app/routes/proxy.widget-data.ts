import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);

  const url = new URL(request.url);
  const subtotal = Number(url.searchParams.get("subtotal") || "0");
  const currency = url.searchParams.get("currency") || "USD";

  return Response.json({
    subtotal,
    currency,
    currentTier: null,
    nextTier: null,
    amountRemaining: 0,
    progressPercent: 0,
    journeyProgressPercent: 0,
    nearThreshold: false,
    recommendations: [],
    labels: {
      primaryMessage: "Add items to unlock your first bulk discount",
      secondaryMessage: null,
      recommendationHeading: "Recommended for your cart",
      configSource: "widget_settings",
    },
  });
};
