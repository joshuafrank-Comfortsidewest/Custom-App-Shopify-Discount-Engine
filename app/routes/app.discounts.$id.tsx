import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, Text, BlockStack } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

type LoaderData = {
  id: string;
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json<LoaderData>({
    id: params.id ?? "",
  });
};

export default function DiscountLegacyDetailsRoute() {
  const data = useLoaderData<typeof loader>() as LoaderData;

  return (
    <Page>
      <TitleBar title="Discount Details" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Discount Created
              </Text>
              <Text as="p" variant="bodyMd">
                Discount ID: {data.id || "unknown"}
              </Text>
              <Text as="p" variant="bodyMd">
                Continue on the Discounts page to configure and validate runtime behavior.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
