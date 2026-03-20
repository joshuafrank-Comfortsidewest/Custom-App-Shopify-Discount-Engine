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

type AppDiscountTypeNode = {
  appKey?: string | null;
  functionId?: string | null;
  title?: string | null;
};

async function resolveFunctionId(admin: any): Promise<{ functionId: string | null; details: string[] }> {
  const details: string[] = [];

  try {
    const response = await admin.graphql(`#graphql
      query ResolveFunctionId {
        appDiscountTypes {
          appKey
          functionId
          title
        }
      }
    `);

    const payload: any = await response.json();
    const gqlErrors = (payload?.errors ?? []).map((e: any) => String(e?.message ?? "GraphQL error"));
    details.push(...gqlErrors);

    const nodes = Array.isArray(payload?.data?.appDiscountTypes)
      ? (payload.data.appDiscountTypes as AppDiscountTypeNode[])
      : [];

    const appKey = String(process.env.SHOPIFY_API_KEY ?? "").trim();

    const preferred =
      nodes.find(
        (node) =>
          String(node?.appKey ?? "").trim() === appKey &&
          String(node?.functionId ?? "").trim().length > 0,
      ) ?? null;

    const fallback =
      nodes.find((node) => String(node?.functionId ?? "").trim().length > 0) ?? null;

    const picked = preferred ?? fallback;
    const functionId = String(picked?.functionId ?? "").trim();

    if (!functionId) {
      if (!gqlErrors.length) {
        details.push("No app discount function was found for this app installation.");
      }
      return { functionId: null, details };
    }

    return { functionId, details };
  } catch (error) {
    return {
      functionId: null,
      details: [error instanceof Error ? error.message : "Failed to resolve function ID."],
    };
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const resolved = await resolveFunctionId(admin);
  const functionId = resolved.functionId ?? "";

  if (!functionId) {
    return json<LoaderData>({
      ok: false,
      functionId,
      error: "Could not resolve function ID for Smart Discount Engine 2.",
      details: resolved.details,
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
            discountClasses: ["PRODUCT", "SHIPPING"],
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
    const errors = [...resolved.details, ...userErrors, ...gqlErrors].filter(Boolean);

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
      details: resolved.details,
    });
  }
};

export default function CreateDiscountLegacyRoute() {
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
                Retry from Shopify Discounts and select Smart Discount Engine 2.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
