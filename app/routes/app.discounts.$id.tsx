import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Layout, Card, Text, BlockStack } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

type LoaderData = {
  id: string;
  functionId: string;
  error: string | null;
};

type AppDiscountTypeNode = {
  appKey?: string | null;
  functionId?: string | null;
  title?: string | null;
};

async function resolveFunctionId(admin: any): Promise<string | null> {
  try {
    const response = await admin.graphql(`#graphql
      query ResolveFunctionIdForLegacyRoute {
        appDiscountTypes {
          appKey
          functionId
          title
        }
      }
    `);

    const payload: any = await response.json();
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
    if (preferred?.functionId) {
      return String(preferred.functionId).trim();
    }

    const fallback =
      nodes.find((node) => String(node?.functionId ?? "").trim().length > 0) ?? null;
    if (fallback?.functionId) {
      return String(fallback.functionId).trim();
    }
  } catch (error) {
    console.error("[discount-legacy-details] resolve-function-id-failed", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }

  return null;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const id = String(params.id ?? "").trim();

  if (!id) {
    return json<LoaderData>({ id: "", functionId: "", error: "Missing discount ID." });
  }

  const functionId = await resolveFunctionId(admin);
  if (functionId) {
    const search = new URL(request.url).search;
    return redirect(
      `/app/discounts/${encodeURIComponent(functionId)}/${encodeURIComponent(id)}${search}`,
    );
  }

  return json<LoaderData>({
    id,
    functionId: "",
    error: "Could not resolve function ID for this installation.",
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
                Discount Details (Legacy Route)
              </Text>
              <Text as="p" variant="bodyMd">
                Discount ID: {data.id || "unknown"}
              </Text>
              {data.error ? (
                <Text as="p" variant="bodyMd" tone="critical">
                  {data.error}
                </Text>
              ) : null}
              <Text as="p" variant="bodyMd">
                Open Discounts and select Smart Discount Engine 2 again.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
