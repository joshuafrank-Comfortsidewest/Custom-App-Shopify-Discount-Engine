import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Banner,
  Badge,
  DataTable,
  TextField,
  Divider,
  Select,
  Tabs,
  ProgressBar,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ── Types ──────────────────────────────────────────────────────────────────────

type JobRow = {
  id: string;
  status: string;
  mode: string;
  targetTag: string | null;
  totalCount: number;
  processedCount: number;
  changedCount: number;
  skippedProtectedCount: number;
  errorsJson: string;
  createdAt: string;
};

type MatchedProduct = {
  id: string;
  title: string;
  sku: string;
  tags: string[];
};

// ── Loader ─────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const jobs = await prisma.autoTagJob
    .findMany({ where: { shop }, orderBy: { createdAt: "desc" }, take: 20 })
    .catch(() => []);

  // Get HVAC-mapped product IDs (protected from discount tagging)
  const hvacMapped = await prisma.hvacSkuMapping
    .findMany({
      where: {
        shop,
        mappedProductId: { not: null },
        matchStatus: { in: ["auto_exact", "manual"] },
      },
      select: { mappedProductId: true },
    })
    .catch(() => []);
  const protectedProductIds = hvacMapped
    .map((m) => m.mappedProductId)
    .filter(Boolean) as string[];

  return json({ jobs, protectedProductIds, shop });
};

// ── Action ─────────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  // ── Match SKUs to products ──
  if (intent === "match_skus") {
    const rawSkus = String(fd.get("skus") ?? "");
    const skus = rawSkus
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (skus.length === 0) {
      return json({ ok: false, message: "No SKUs provided.", intent });
    }

    const matched: MatchedProduct[] = [];
    const notFound: string[] = [];

    for (const sku of skus) {
      try {
        const res = await admin.graphql(
          `
          #graphql
          query FindBySku($query: String!) {
            products(first: 5, query: $query) {
              nodes {
                id
                title
                tags
                variants(first: 20) {
                  nodes { id sku }
                }
              }
            }
          }`,
          { variables: { query: `sku:${sku}` } },
        );
        const data = await res.json();
        const products = data?.data?.products?.nodes ?? [];

        let found = false;
        for (const product of products) {
          for (const variant of product.variants?.nodes ?? []) {
            const vSku = (variant.sku || "").trim().toUpperCase();
            if (vSku === sku.toUpperCase()) {
              // Avoid duplicates
              if (!matched.find((m) => m.id === product.id)) {
                matched.push({
                  id: product.id,
                  title: product.title,
                  sku: variant.sku,
                  tags: product.tags ?? [],
                });
              }
              found = true;
              break;
            }
          }
          if (found) break;
        }

        if (!found) notFound.push(sku);
      } catch {
        notFound.push(sku);
      }
    }

    return json({
      ok: true,
      intent,
      message: `Matched ${matched.length} products. ${notFound.length} SKUs not found.`,
      matched,
      notFound,
    });
  }

  // ── Start tag job ──
  if (intent === "start_tag_job") {
    const tag = String(fd.get("tag") ?? "").trim();
    const mode = String(fd.get("mode") ?? "tag");
    const matchedJson = String(fd.get("matched_products") ?? "[]");

    if (!tag) {
      return json({ ok: false, message: "No tag provided.", intent });
    }

    let products: MatchedProduct[];
    try {
      products = JSON.parse(matchedJson);
    } catch {
      return json({ ok: false, message: "Invalid matched products data.", intent });
    }

    if (products.length === 0) {
      return json({ ok: false, message: "No products to tag.", intent });
    }

    // Get HVAC protected product IDs
    const hvacMapped = await prisma.hvacSkuMapping.findMany({
      where: {
        shop,
        mappedProductId: { not: null },
        matchStatus: { in: ["auto_exact", "manual"] },
      },
      select: { mappedProductId: true },
    });
    const protectedIds = new Set(
      hvacMapped.map((m) => m.mappedProductId).filter(Boolean),
    );

    // Create job record
    const job = await prisma.autoTagJob.create({
      data: {
        shop,
        discountNodeId: "manual",
        status: "running",
        mode,
        targetTag: tag,
        inputSkusJson: JSON.stringify(products.map((p) => p.sku)),
        matchedProductsJson: matchedJson,
        totalCount: products.length,
      },
    });

    // Process tagging
    let changedCount = 0;
    let skippedProtected = 0;
    const changes: Array<{ id: string; title: string; action: string }> = [];
    const errors: string[] = [];

    for (let i = 0; i < products.length; i++) {
      const product = products[i];

      // Skip protected HVAC products
      if (protectedIds.has(product.id)) {
        skippedProtected++;
        continue;
      }

      try {
        if (mode === "tag") {
          // Add tag
          if (!product.tags.includes(tag)) {
            await admin.graphql(
              `
              #graphql
              mutation TagsAdd($id: ID!, $tags: [String!]!) {
                tagsAdd(id: $id, tags: $tags) {
                  userErrors { field message }
                }
              }`,
              { variables: { id: product.id, tags: [tag] } },
            );
            changedCount++;
            changes.push({ id: product.id, title: product.title, action: `added "${tag}"` });
          }
        } else {
          // Remove tag
          if (product.tags.includes(tag)) {
            await admin.graphql(
              `
              #graphql
              mutation TagsRemove($id: ID!, $tags: [String!]!) {
                tagsRemove(id: $id, tags: $tags) {
                  userErrors { field message }
                }
              }`,
              { variables: { id: product.id, tags: [tag] } },
            );
            changedCount++;
            changes.push({ id: product.id, title: product.title, action: `removed "${tag}"` });
          }
        }
      } catch (err) {
        errors.push(
          `${product.title}: ${err instanceof Error ? err.message : "unknown error"}`,
        );
      }

      // Update progress
      await prisma.autoTagJob.update({
        where: { id: job.id },
        data: {
          processedCount: i + 1,
          changedCount,
          skippedProtectedCount: skippedProtected,
          changesJson: JSON.stringify(changes),
          errorsJson: JSON.stringify(errors),
        },
      });
    }

    // Mark complete
    await prisma.autoTagJob.update({
      where: { id: job.id },
      data: {
        status: errors.length > 0 ? "completed" : "completed",
        processedCount: products.length,
        changedCount,
        skippedProtectedCount: skippedProtected,
        changesJson: JSON.stringify(changes),
        errorsJson: JSON.stringify(errors),
      },
    });

    return json({
      ok: true,
      intent,
      message: `${mode === "tag" ? "Tagged" : "Untagged"} ${changedCount} products with "${tag}". ${skippedProtected} HVAC-protected skipped. ${errors.length} errors.`,
    });
  }

  // ── Delete job ──
  if (intent === "delete_job") {
    const jobId = String(fd.get("job_id") ?? "");
    if (jobId) {
      await prisma.autoTagJob.delete({ where: { id: jobId } }).catch(() => {});
    }
    return json({ ok: true, message: "Job deleted.", intent });
  }

  // ── Clear all jobs ──
  if (intent === "clear_jobs") {
    const count = await prisma.autoTagJob.deleteMany({ where: { shop } });
    return json({ ok: true, message: `Deleted ${count.count} jobs.`, intent });
  }

  return json({ ok: false, message: `Unknown intent: ${intent}`, intent });
};

// ── Component ──────────────────────────────────────────────────────────────────

export default function AutoTaggingRoute() {
  const { jobs, protectedProductIds } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isSubmitting = navigation.state === "submitting";

  const [tabIdx, setTabIdx] = useState(0);
  const [skuInput, setSkuInput] = useState("");
  const [tagName, setTagName] = useState("");
  const [tagMode, setTagMode] = useState("tag");

  // Matched products from the match step
  const matchedProducts: MatchedProduct[] =
    actionData?.intent === "match_skus" ? (actionData as any).matched ?? [] : [];
  const notFoundSkus: string[] =
    actionData?.intent === "match_skus" ? (actionData as any).notFound ?? [] : [];

  const tabs = [
    { id: "tag", content: "Tag Products" },
    { id: "history", content: `Job History (${jobs.length})` },
  ];

  const handleStartJob = () => {
    if (!tagName.trim() || matchedProducts.length === 0) return;
    const fd = new FormData();
    fd.set("intent", "start_tag_job");
    fd.set("tag", tagName);
    fd.set("mode", tagMode);
    fd.set("matched_products", JSON.stringify(matchedProducts));
    submit(fd, { method: "post" });
  };

  return (
    <Page>
      <TitleBar title="Auto-Tagging" />
      <Layout>
        {actionData?.message && (
          <Layout.Section>
            <Banner
              tone={actionData.ok ? "success" : "critical"}
              title={actionData.message}
            />
          </Layout.Section>
        )}

        <Layout.Section>
          <Tabs tabs={tabs} selected={tabIdx} onSelect={setTabIdx} />
        </Layout.Section>

        {/* ── Tag Products Tab ── */}
        {tabIdx === 0 && (
          <Layout.Section>
            <BlockStack gap="400">
              {/* Step 1: Paste SKUs */}
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Step 1: Paste SKUs
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Paste a list of SKUs (one per line or comma-separated). These
                    will be matched to your Shopify products.
                  </Text>
                  <TextField
                    label="SKUs"
                    value={skuInput}
                    onChange={setSkuInput}
                    multiline={6}
                    autoComplete="off"
                    placeholder={"SKU-001\nSKU-002\nSKU-003"}
                  />
                  <form method="post">
                    <input type="hidden" name="intent" value="match_skus" />
                    <input type="hidden" name="skus" value={skuInput} />
                    <Button submit loading={isSubmitting} variant="primary">
                      Match SKUs to Products
                    </Button>
                  </form>
                </BlockStack>
              </Card>

              {/* Step 2: Review matches */}
              {matchedProducts.length > 0 && (
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">
                      Step 2: Review Matches ({matchedProducts.length} found)
                    </Text>
                    {notFoundSkus.length > 0 && (
                      <Banner tone="warning">
                        <Text as="p" variant="bodyMd">
                          Not found: {notFoundSkus.join(", ")}
                        </Text>
                      </Banner>
                    )}
                    <DataTable
                      columnContentTypes={["text", "text", "text"]}
                      headings={["Product", "SKU", "Current Tags"]}
                      rows={matchedProducts.slice(0, 50).map((p) => [
                        p.title,
                        p.sku,
                        p.tags.length > 0 ? p.tags.join(", ") : "—",
                      ])}
                      truncate
                    />
                    {matchedProducts.length > 50 && (
                      <Text as="p" variant="bodyMd" tone="subdued">
                        Showing 50 of {matchedProducts.length} products.
                      </Text>
                    )}
                  </BlockStack>
                </Card>
              )}

              {/* Step 3: Apply tags */}
              {matchedProducts.length > 0 && (
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">
                      Step 3: Apply / Remove Tag
                    </Text>
                    {protectedProductIds.length > 0 && (
                      <Banner tone="info">
                        <Text as="p" variant="bodyMd">
                          {protectedProductIds.length} HVAC-mapped products are
                          protected and will be skipped.
                        </Text>
                      </Banner>
                    )}
                    <InlineStack gap="300" align="start" blockAlign="end">
                      <div style={{ minWidth: 200 }}>
                        <TextField
                          label="Tag Name"
                          value={tagName}
                          onChange={setTagName}
                          autoComplete="off"
                          placeholder="e.g. 5 off, 10 off"
                        />
                      </div>
                      <div style={{ minWidth: 150 }}>
                        <Select
                          label="Mode"
                          options={[
                            { label: "Add Tag", value: "tag" },
                            { label: "Remove Tag", value: "untag_discount" },
                          ]}
                          value={tagMode}
                          onChange={setTagMode}
                        />
                      </div>
                    </InlineStack>
                    <Button
                      onClick={handleStartJob}
                      loading={isSubmitting}
                      variant="primary"
                      tone={tagMode === "untag_discount" ? "critical" : undefined}
                      disabled={!tagName.trim()}
                    >
                      {tagMode === "tag"
                        ? `Add "${tagName || "..."}" to ${matchedProducts.length} products`
                        : `Remove "${tagName || "..."}" from ${matchedProducts.length} products`}
                    </Button>
                  </BlockStack>
                </Card>
              )}
            </BlockStack>
          </Layout.Section>
        )}

        {/* ── Job History Tab ── */}
        {tabIdx === 1 && (
          <Layout.Section>
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  <InlineStack align="space-between">
                    <Text as="h2" variant="headingMd">
                      Recent Jobs
                    </Text>
                    <form method="post">
                      <input type="hidden" name="intent" value="clear_jobs" />
                      <Button
                        submit
                        loading={isSubmitting}
                        variant="plain"
                        tone="critical"
                      >
                        Clear History
                      </Button>
                    </form>
                  </InlineStack>

                  {(jobs as JobRow[]).length === 0 ? (
                    <Text as="p" variant="bodyMd" tone="subdued">
                      No tagging jobs yet.
                    </Text>
                  ) : (
                    <DataTable
                      columnContentTypes={[
                        "text",
                        "text",
                        "text",
                        "numeric",
                        "numeric",
                        "numeric",
                        "text",
                      ]}
                      headings={[
                        "Tag",
                        "Mode",
                        "Status",
                        "Total",
                        "Changed",
                        "Skipped",
                        "Created",
                      ]}
                      rows={(jobs as JobRow[]).map((j) => [
                        j.targetTag ?? "—",
                        j.mode === "tag" ? "Add" : "Remove",
                        j.status === "completed" ? (
                          <Badge tone="success">done</Badge>
                        ) : j.status === "failed" ? (
                          <Badge tone="critical">failed</Badge>
                        ) : (
                          <Badge tone="attention">{j.status}</Badge>
                        ),
                        String(j.totalCount),
                        String(j.changedCount),
                        String(j.skippedProtectedCount),
                        new Date(j.createdAt).toLocaleDateString(),
                      ])}
                    />
                  )}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
