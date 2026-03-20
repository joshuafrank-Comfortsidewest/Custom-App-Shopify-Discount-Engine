import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, Text, BlockStack, List } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

const FUNCTION_HANDLE = "smart-discount-engine-core";
const FUNCTION_CONFIG_KEY = "function-configuration";
const ADMIN_CONFIG_KEY = "admin-configuration";

type LoaderData = {
  ok: boolean;
  error: string | null;
  details: string[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      mutation CreateAutomaticAppDiscount($automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount {
            discountId
            title
            status
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        automaticAppDiscount: {
          title: `Smart Discount ${Date.now()}`,
          functionHandle: FUNCTION_HANDLE,
          startsAt: new Date().toISOString(),
          combinesWith: {
            orderDiscounts: true,
            productDiscounts: true,
            shippingDiscounts: true,
          },
          metafields: [
            {
              namespace: "$app",
              key: FUNCTION_CONFIG_KEY,
              type: "json",
              value: "{}",
            },
            {
              namespace: "$app",
              key: ADMIN_CONFIG_KEY,
              type: "json",
              value: "{}",
            },
          ],
        },
      },
    },
  );

  const payload: any = await response.json();

  const userErrors =
    payload?.data?.discountAutomaticAppCreate?.userErrors?.map((e: any) => String(e?.message ?? "")) ??
    [];
  const gqlErrors = (payload?.errors ?? []).map((e: any) => String(e?.message ?? "GraphQL error"));
  const errors = [...userErrors, ...gqlErrors].filter(Boolean);

  const discountId = String(
    payload?.data?.discountAutomaticAppCreate?.automaticAppDiscount?.discountId ?? "",
  ).trim();

  if (!errors.length && discountId) {
    const shortId = discountId.match(/\/(\d+)$/)?.[1] ?? encodeURIComponent(discountId);
    return redirect(`/app/discounts/${shortId}`);
  }

  return json<LoaderData>({
    ok: false,
    error: errors[0] || "Failed to create discount from Smart Discount Engine 2.",
    details: errors.slice(1),
  });
};

export default function CreateDiscountRoute() {
  const data = useLoaderData<typeof loader>() as LoaderData;

  return (
    <Page>
      <TitleBar title="Create Discount" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Discount creation failed
              </Text>
              <Text as="p" variant="bodyMd" tone="critical">
                {data.error}
              </Text>
              {data.details.length > 0 ? (
                <List type="bullet">
                  {data.details.map((item, idx) => (
                    <List.Item key={`${idx}:${item}`}>{item}</List.Item>
                  ))}
                </List>
              ) : null}
              <Text as="p" variant="bodyMd">
                Retry from Shopify Discounts and select Smart Discount Engine 2 again.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

