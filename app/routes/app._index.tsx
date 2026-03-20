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
                Clean v2 baseline is live
              </Text>
              <Text as="p" variant="bodyMd">
                This app was reset from scratch. The current discount function
                is intentionally a safe no-op while new logic is rebuilt.
              </Text>
              <Text as="p" variant="bodyMd">
                Continue on the{" "}
                <Link url="/app/discounts" removeUnderline>
                  Discounts
                </Link>{" "}
                page to build and validate the new rules engine.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
