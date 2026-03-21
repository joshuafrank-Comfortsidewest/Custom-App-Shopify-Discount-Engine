import type { LoaderFunctionArgs } from "@remix-run/node";
import { Page, Layout, Card, Text, BlockStack, Link } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function AppHome() {
  return (
    <Page>
      <TitleBar title="Smart Discount Engine 2" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Smart Discount Engine v2
              </Text>
              <Text as="p" variant="bodyMd">
                The checkout function applies first-order, bulk, VIP, item collection,
                and HVAC bundle discounts based on your saved configuration.
              </Text>
              <Text as="p" variant="bodyMd">
                Continue on the{" "}
                <Link url="/app/discounts" removeUnderline>
                  Discounts
                </Link>{" "}
                page to configure discount rules, or go to{" "}
                <Link url="/app/hvac-mapping" removeUnderline>
                  HVAC Mapping
                </Link>{" "}
                to manage SKU-to-product mappings and auto-tagging.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
