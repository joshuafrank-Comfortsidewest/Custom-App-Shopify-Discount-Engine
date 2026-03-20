import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  // Compatibility route for older extension UI paths.
  // New installs use /app/discounts/:functionId/new.
  return redirect("/app/discounts");
};

export default function LegacyDiscountCreateRedirect() {
  return null;
}
