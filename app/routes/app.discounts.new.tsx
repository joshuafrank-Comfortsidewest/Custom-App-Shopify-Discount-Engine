import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, redirect } from "react-router";
import { authenticate } from "../shopify.server";

const FUNCTION_HANDLE = "smart-discount-engine-core";
const FUNCTION_CONFIG_KEY = "function-configuration";
const ADMIN_CONFIG_KEY = "admin-configuration";

type LoaderData = {
  error: string;
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
    }`,
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

  const json: any = await response.json();
  const userErrors =
    json?.data?.discountAutomaticAppCreate?.userErrors?.map((e: any) => String(e?.message ?? "")) ?? [];
  const graphqlErrors = (json?.errors ?? []).map((e: any) => String(e?.message ?? "GraphQL error"));
  const errors = [...userErrors, ...graphqlErrors].filter(Boolean);

  const discountId = String(
    json?.data?.discountAutomaticAppCreate?.automaticAppDiscount?.discountId ?? "",
  ).trim();

  if (!errors.length && discountId) {
    const shortId = discountId.match(/\/(\d+)$/)?.[1] ?? encodeURIComponent(discountId);
    throw redirect(`/app/discounts/${shortId}`);
  }

  return {
    error: errors[0] || "Failed to create Smart Discount.",
    details: errors.slice(1),
  } satisfies LoaderData;
};

export default function DiscountCreateRoute() {
  const data = useLoaderData<typeof loader>() as LoaderData;
  return (
    <s-page heading="Create Smart Discount">
      <s-section heading="Create failed">
        <s-banner tone="warning">{data.error}</s-banner>
        {data.details.length ? (
          <s-unordered-list>
            {data.details.map((message, idx) => (
              <s-list-item key={`${idx}:${message}`}>{message}</s-list-item>
            ))}
          </s-unordered-list>
        ) : null}
        <s-paragraph>
          Retry by reopening this page from Discounts and selecting
          <s-text> smart-discount-engine-core</s-text>.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
