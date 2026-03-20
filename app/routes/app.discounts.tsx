import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  List,
  Badge,
  InlineStack,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useLoaderData } from "@remix-run/react";
import { authenticate } from "../shopify.server";

type RuntimeStatus = {
  hasRuntimeConfig: boolean;
  chunked: boolean;
  manifestParts: number;
  runtimeBytes: number;
  itemRuleCount: number;
  itemRuleProductCount: number;
  hvacEnabled: boolean;
  hvacRuleCount: number;
  parseError: string | null;
};

type RuntimeManifest = {
  chunked?: boolean;
  parts?: number;
};

function decodeJsonString(raw: string): string {
  try {
    const decoded = JSON.parse(raw);
    return typeof decoded === "string" ? decoded : raw;
  } catch {
    return raw;
  }
}

function resolveRuntimeConfig(primary: string | null, parts: Array<string | null>): { json: string | null; chunked: boolean; manifestParts: number } {
  if (primary) {
    const primaryDecoded = decodeJsonString(primary);
    try {
      const manifest = JSON.parse(primaryDecoded) as RuntimeManifest;
      if (manifest?.chunked) {
        const count = Number(manifest.parts || 0);
        if (count > 0) {
          let joined = "";
          for (let i = 0; i < count; i += 1) {
            const part = parts[i];
            if (!part) return { json: null, chunked: true, manifestParts: count };
            const decodedPart = decodeJsonString(part);
            if (!decodedPart) return { json: null, chunked: true, manifestParts: count };
            joined += decodedPart;
          }
          return { json: joined, chunked: true, manifestParts: count };
        }
      }
    } catch {
      // Primary is not a manifest, treat as direct JSON payload.
    }

    if (primaryDecoded) {
      return { json: primaryDecoded, chunked: false, manifestParts: 0 };
    }
  }

  const fallback = parts
    .map((value) => (value ? decodeJsonString(value) : ""))
    .filter(Boolean)
    .join("");

  return { json: fallback || null, chunked: false, manifestParts: 0 };
}

function summarizeRuntime(jsonRaw: string | null, chunked: boolean, manifestParts: number): RuntimeStatus {
  if (!jsonRaw) {
    return {
      hasRuntimeConfig: false,
      chunked,
      manifestParts,
      runtimeBytes: 0,
      itemRuleCount: 0,
      itemRuleProductCount: 0,
      hvacEnabled: false,
      hvacRuleCount: 0,
      parseError: "No runtime config found in smart_discount_engine metafields.",
    };
  }

  try {
    const parsed = JSON.parse(jsonRaw) as any;
    const itemRules = Array.isArray(parsed?.item_collection_rules)
      ? parsed.item_collection_rules
      : [];
    const hvacRules = Array.isArray(parsed?.hvac_rule?.combination_rules)
      ? parsed.hvac_rule.combination_rules
      : [];

    return {
      hasRuntimeConfig: true,
      chunked,
      manifestParts,
      runtimeBytes: Buffer.byteLength(jsonRaw, "utf8"),
      itemRuleCount: itemRules.length,
      itemRuleProductCount: itemRules.reduce((sum: number, rule: any) => {
        const products = Array.isArray(rule?.product_ids) ? rule.product_ids.length : 0;
        return sum + products;
      }, 0),
      hvacEnabled: Boolean(parsed?.hvac_rule?.enabled || parsed?.toggles?.hvac_enabled),
      hvacRuleCount: hvacRules.length,
      parseError: null,
    };
  } catch (error) {
    return {
      hasRuntimeConfig: false,
      chunked,
      manifestParts,
      runtimeBytes: Buffer.byteLength(jsonRaw, "utf8"),
      itemRuleCount: 0,
      itemRuleProductCount: 0,
      hvacEnabled: false,
      hvacRuleCount: 0,
      parseError: error instanceof Error ? error.message : "Failed to parse runtime config JSON.",
    };
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(`#graphql
    query RuntimeStatus {
      shop {
        runtimeConfig: metafield(namespace: "smart_discount_engine", key: "config") { value }
        runtimeConfigPart1: metafield(namespace: "smart_discount_engine", key: "config-part-1") { value }
        runtimeConfigPart2: metafield(namespace: "smart_discount_engine", key: "config-part-2") { value }
        runtimeConfigPart3: metafield(namespace: "smart_discount_engine", key: "config-part-3") { value }
        runtimeConfigPart4: metafield(namespace: "smart_discount_engine", key: "config-part-4") { value }
        runtimeConfigPart5: metafield(namespace: "smart_discount_engine", key: "config-part-5") { value }
        runtimeConfigPart6: metafield(namespace: "smart_discount_engine", key: "config-part-6") { value }
        runtimeConfigPart7: metafield(namespace: "smart_discount_engine", key: "config-part-7") { value }
        runtimeConfigPart8: metafield(namespace: "smart_discount_engine", key: "config-part-8") { value }
      }
    }
  `);

  const payload = await response.json();
  const shop = payload?.data?.shop;

  const primary = shop?.runtimeConfig?.value ?? null;
  const parts = [
    shop?.runtimeConfigPart1?.value ?? null,
    shop?.runtimeConfigPart2?.value ?? null,
    shop?.runtimeConfigPart3?.value ?? null,
    shop?.runtimeConfigPart4?.value ?? null,
    shop?.runtimeConfigPart5?.value ?? null,
    shop?.runtimeConfigPart6?.value ?? null,
    shop?.runtimeConfigPart7?.value ?? null,
    shop?.runtimeConfigPart8?.value ?? null,
  ] as Array<string | null>;

  const resolved = resolveRuntimeConfig(primary, parts);
  const status = summarizeRuntime(resolved.json, resolved.chunked, resolved.manifestParts);

  return json({ status });
};

export default function DiscountsPage() {
  const { status } = useLoaderData<typeof loader>();

  return (
    <Page>
      <TitleBar title="Discounts" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">
                  Discount Engine v2
                </Text>
                <Badge tone={status.hasRuntimeConfig ? "success" : "critical"}>
                  {status.hasRuntimeConfig ? "Runtime Loaded" : "Runtime Missing"}
                </Badge>
              </InlineStack>

              <List type="bullet">
                <List.Item>Chunked config: {status.chunked ? "Yes" : "No"}</List.Item>
                <List.Item>Manifest parts: {status.manifestParts}</List.Item>
                <List.Item>Runtime size: {status.runtimeBytes} bytes</List.Item>
                <List.Item>Item rules: {status.itemRuleCount}</List.Item>
                <List.Item>Item-rule products: {status.itemRuleProductCount}</List.Item>
                <List.Item>HVAC enabled: {status.hvacEnabled ? "Yes" : "No"}</List.Item>
                <List.Item>HVAC rules: {status.hvacRuleCount}</List.Item>
              </List>

              {status.parseError ? (
                <Text as="p" variant="bodyMd" tone="critical">
                  Runtime parse warning: {status.parseError}
                </Text>
              ) : (
                <Text as="p" variant="bodyMd">
                  Checkout function now reads these runtime metafields directly with low-complexity input.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
