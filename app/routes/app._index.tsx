import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function Index() {
  return (
    <s-page heading="Smart Discount Engine">
      <s-section heading="Control Center">
        <s-paragraph>
          Manage discount rules for first-order, bulk, VIP, item-level collections, other discounts,
          HVAC combination rules, and automated collection tagging from one place.
        </s-paragraph>
        <s-stack direction="inline" gap="base">
          <s-link href="/app/discounts/new">Open discount setup</s-link>
          <s-link href="/app/hvac-mapping">Open HVAC mapping</s-link>
        </s-stack>
      </s-section>

      <s-section heading="What this app handles">
        <s-unordered-list>
          <s-list-item>Order-level tiers: First, Bulk, and VIP with anti-stacking behavior.</s-list-item>
          <s-list-item>Item Rules and Other Discounts with eligibility and spend-step controls.</s-list-item>
          <s-list-item>HVAC-specific bundle logic with stackable or exclusive-best modes.</s-list-item>
          <s-list-item>Automatic collection tag operations with history and undo workflow.</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Recommended workflow">
        <s-unordered-list>
          <s-list-item>1. Confirm HVAC mapping and product coverage.</s-list-item>
          <s-list-item>2. Configure discount rules and save.</s-list-item>
          <s-list-item>3. Validate cart scenarios on storefront.</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Launch tips">
        <s-unordered-list>
          <s-list-item>Keep production labels customer-friendly.</s-list-item>
          <s-list-item>Validate tier thresholds against real AOV targets.</s-list-item>
          <s-list-item>Use one discount owner config as your source of truth.</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
