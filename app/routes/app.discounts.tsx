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
import { useLoaderData, useOutlet } from "@remix-run/react";
import { authenticate } from "../shopify.server";

type RuntimeStatus = {
  hasRuntimeConfig: boolean;
  runtimeBytes: number;
  itemRuleCount: number;
  hvacEnabled: boolean;
  hvacRuleCount: number;
  parseError: string | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(`#graphql
    query RuntimeStatus {
      shop {
        runtimeConfig: metafield(namespace: "smart_discount_engine", key: "config") { value }
      }
    }
  `);

  const payload = await response.json();
  const configValue = payload?.data?.shop?.runtimeConfig?.value ?? null;

  let status: RuntimeStatus;

  if (!configValue) {
    status = {
      hasRuntimeConfig: false,
      runtimeBytes: 0,
      itemRuleCount: 0,
      hvacEnabled: false,
      hvacRuleCount: 0,
      parseError: "No runtime config found in smart_discount_engine metafield.",
    };
  } else {
    try {
      const parsed = JSON.parse(configValue) as any;
      const itemRules = Array.isArray(parsed?.item_collection_rules)
        ? parsed.item_collection_rules
        : [];
      const hvacRules = Array.isArray(parsed?.hvac_rule?.combination_rules)
        ? parsed.hvac_rule.combination_rules
        : [];

      status = {
        hasRuntimeConfig: true,
        runtimeBytes: Buffer.byteLength(configValue, "utf8"),
        itemRuleCount: itemRules.length,
        hvacEnabled: Boolean(parsed?.hvac_rule?.enabled || parsed?.toggles?.hvac_enabled),
        hvacRuleCount: hvacRules.length,
        parseError: null,
      };
    } catch (error) {
      status = {
        hasRuntimeConfig: false,
        runtimeBytes: Buffer.byteLength(configValue, "utf8"),
        itemRuleCount: 0,
        hvacEnabled: false,
        hvacRuleCount: 0,
        parseError: error instanceof Error ? error.message : "Failed to parse runtime config JSON.",
      };
    }
  }

  return json({ status });
};

export default function DiscountsPage() {
  const { status } = useLoaderData<typeof loader>();
  const outlet = useOutlet();

  if (outlet) {
    return <>{outlet}</>;
  }

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
                <List.Item>Runtime size: {status.runtimeBytes} bytes</List.Item>
                <List.Item>Item rules: {status.itemRuleCount} (discount % stored on products)</List.Item>
                <List.Item>HVAC enabled: {status.hvacEnabled ? "Yes" : "No"}</List.Item>
                <List.Item>HVAC rules: {status.hvacRuleCount}</List.Item>
              </List>

              {status.parseError ? (
                <Text as="p" variant="bodyMd" tone="critical">
                  Runtime parse warning: {status.parseError}
                </Text>
              ) : (
                <Text as="p" variant="bodyMd">
                  Item discounts are stored as product metafields. Config contains only settings, HVAC rules, and spend rules.
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
