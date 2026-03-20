import type { LoaderFunctionArgs } from "@remix-run/node";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  List,
  Badge,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function DiscountsPage() {
  return (
    <Page>
      <TitleBar title="Discounts" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Discount Engine v2
              </Text>
              <Badge tone="info">Baseline</Badge>
              <Text as="p" variant="bodyMd">
                Fresh restart complete. This page is the new starting point for
                rebuilding settings UI and checkout logic.
              </Text>
              <List type="bullet">
                <List.Item>Function is deployed as no-op baseline.</List.Item>
                <List.Item>No hardcoded discount percentages are active.</List.Item>
                <List.Item>
                  Next step: implement rule storage and runtime matching.
                </List.Item>
              </List>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
