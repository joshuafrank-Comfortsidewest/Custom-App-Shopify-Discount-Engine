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

async function resolveFunctionCandidates(admin: any, preferred: string): Promise<string[]> {
  const ids: string[] = [];
  if (preferred) {
    ids.push(preferred);
  }

  try {
    const response = await admin.graphql(`#graphql
      query ResolveFunctionIdCandidates {
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

    const preferredNode =
      nodes.find(
        (node) =>
          String(node?.appKey ?? "").trim() === appKey &&
          String(node?.functionId ?? "").trim().length > 0,
      ) ?? null;

    if (preferredNode?.functionId) {
      ids.push(String(preferredNode.functionId).trim());
    }

    for (const node of nodes) {
      const id = String(node?.functionId ?? "").trim();
      if (id) {
        ids.push(id);
      }
    }
  } catch (error) {
    console.error("[discount-create] resolve-candidates-failed", {
      preferred,
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }

  return [...new Set(ids)];
}

async function tryCreateDiscount(admin: any, functionId: string) {
  const startsAt = new Date().toISOString();
  const endsAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 10).toISOString();

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
          startsAt,
          endsAt,
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
    payload?.data?.discountAutomaticAppCreate?.userErrors?.map((e: any) => String(e?.message ?? "")) ?? [];
  const gqlErrors = (payload?.errors ?? []).map((e: any) => String(e?.message ?? "GraphQL error"));
  const errors = [...userErrors, ...gqlErrors].filter(Boolean);
  const discountId = String(
    payload?.data?.discountAutomaticAppCreate?.automaticAppDiscount?.discountId ?? "",
  ).trim();

  return { errors, discountId };
}

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
    const candidates = await resolveFunctionCandidates(admin, functionId);
    const attemptErrors: string[] = [];

    console.log("[discount-create] candidates", { functionId, candidates });

    for (const candidate of candidates) {
      const attempt = await tryCreateDiscount(admin, candidate);
      console.log("[discount-create] attempt-result", {
        requestedFunctionId: functionId,
        candidateFunctionId: candidate,
        errorCount: attempt.errors.length,
        errors: attempt.errors,
        hasDiscountId: Boolean(attempt.discountId),
      });

      if (!attempt.errors.length && attempt.discountId) {
        const shortId = attempt.discountId.match(/\/(\d+)$/)?.[1] ?? encodeURIComponent(attempt.discountId);
        return redirect(`/app/discounts/${encodeURIComponent(candidate)}/${shortId}`);
      }

      if (attempt.errors.length) {
        attemptErrors.push(`[${candidate}] ${attempt.errors[0]}`);
        for (const extra of attempt.errors.slice(1)) {
          attemptErrors.push(`[${candidate}] ${extra}`);
        }
      } else {
        attemptErrors.push(`[${candidate}] Failed to create discount with no detailed error.`);
      }
    }

    if (!candidates.length) {
      attemptErrors.push("No function IDs were available from this app installation.");
    }

    return json<LoaderData>({
      ok: false,
      functionId,
      error: attemptErrors[0] || "Failed to create discount.",
      details: attemptErrors.slice(1),
    });
  } catch (error) {
    console.error("[discount-create] loader-exception", {
      functionId,
      message: error instanceof Error ? error.message : "Unknown error",
    });
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
