import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function DiscountCreateRoute() {
  return (
    <s-page heading="Create Smart Discount">
      <s-section heading="How to create">
        <s-paragraph>
          Create this discount from Admin GraphiQL using the
          <s-text> discountAutomaticAppCreate </s-text>
          mutation, then open the discount to manage settings.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
