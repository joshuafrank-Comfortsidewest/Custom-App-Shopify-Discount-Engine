import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, Text, BlockStack, List } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

type LoaderData = {
  ok: boolean;
  error: string | null;
  details: string[];
  functionId: string;
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const functionId = String(params.functionId ?? "").trim();

  if (!functionId) {
    return json<LoaderData>({
      ok: false,
      functionId,
      error: "Missing functionId in route. Re-open discount type from Shopify Discounts.",
      details: [],
    });
  }

  try {
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
            functionId,
            startsAt: new Date().toISOString(),
            combinesWith: {
              orderDiscounts: true,
              productDiscounts: true,
              shippingDiscounts: true,
            },
            metafields: [
              {
                namespace: "$app",
                key: "function-configuration",
                type: "json",
                value: "{}",
              },
              {
                namespace: "$app",
                key: "admin-configuration",
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
      return redirect(`/app/discounts/${encodeURIComponent(functionId)}/${shortId}`);
    }

    return json<LoaderData>({
      ok: false,
      functionId,
      error: errors[0] || "Failed to create discount.",
      details: errors.slice(1),
    });
  } catch (error) {
    return json<LoaderData>({
      ok: false,
      functionId,
      error: error instanceof Error ? error.message : "Unexpected error creating discount.",
      details: [],
    });
  }
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
              <Text as="p" variant="bodyMd">
                Function ID: {data.functionId || "unknown"}
              </Text>
              {data.details.length > 0 ? (
                <List type="bullet">
                  {data.details.map((item, idx) => (
                    <List.Item key={`${idx}:${item}`}>{item}</List.Item>
                  ))}
                </List>
              ) : null}
              <Text as="p" variant="bodyMd">
                Go back to Discounts and pick Smart Discount Engine 2 again.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

