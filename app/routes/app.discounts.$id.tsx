import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // Compatibility route for previously-created discounts that still resolve
  // to /app/discounts/:id from older app versions.
  return redirect("/app/discounts");
};

export default function LegacyDiscountDetailsRedirect() {
  return null;
}
