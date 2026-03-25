import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation, useSubmit } from "@remix-run/react";
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

// ── SKU helpers ────────────────────────────────────────────────────────────────

/**
 * Strip leading/trailing quantity multipliers such as:
 *   3X SKU  |  SKU 3X  |  x3 SKU  |  SKU x3  (case-insensitive, any number)
 * Returns the bare SKU in UPPER CASE.
 */
function stripMultiplier(raw: string): string {
  let s = raw.trim().toUpperCase();
  s = s.replace(/^(\d+X|X\d+)\s+/, "");  // prefix: "3X " or "X3 "
  s = s.replace(/\s+(\d+X|X\d+)$/, "");  // suffix: " 3X" or " X3"
  return s.trim();
}

/**
 * A Shopify variant's SKU field may contain multiple SKUs joined by " + ".
 * Returns all core (multiplier-stripped, uppercased) SKUs from the field.
 */
function variantCoreSkus(skuField: string): string[] {
  return skuField
    .split("+")
    .map((p) => stripMultiplier(p))
    .filter(Boolean);
}

/**
 * Normalize a single SKU component for exact matching — keeps the multiplier
 * value but canonicalizes its position to a "NxCORE" prefix form.
 *   "2X SKU-A"  →  "2XSKU-A"
 *   "SKU-A 2X"  →  "2XSKU-A"
 *   "X2 SKU-A"  →  "2XSKU-A"
 *   "SKU-A"     →  "SKU-A"   (no multiplier)
 */
function normalizeComponentExact(raw: string): string {
  let s = raw.trim().toUpperCase();
  // prefix: "3X SKU" or "X3 SKU"
  let m = s.match(/^(\d+X|X\d+)\s+(.+)$/);
  if (m) {
    const num = m[1].replace(/X/g, "");
    return `${num}X${m[2].trim()}`;
  }
  // suffix: "SKU 3X" or "SKU X3"
  m = s.match(/^(.+)\s+(\d+X|X\d+)$/);
  if (m) {
    const num = m[2].replace(/X/g, "");
    return `${num}X${m[1].trim()}`;
  }
  return s;
}

/** Pattern for discount tags like "5 off", "10.51 off" */
const DISCOUNT_TAG_RE = /^(\d+(?:\.\d+)?)\s+off$/i;

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
    // "component" = strip multipliers, find any product containing those core SKUs
    // "exact"     = keep multipliers, order-insensitive exact set match
    const searchMode = fd.get("searchMode") === "exact" ? "exact" : "component";
    const skus = rawSkus
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (skus.length === 0) {
      return json({ ok: false, message: "No SKUs provided.", intent });
    }

    const matched: MatchedProduct[] = [];
    const notFound: string[] = [];

    // Reusable GraphQL search: paginates all products matching a single SKU term
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function searchBySku(searchTerm: string, onVariant: (product: any, variant: any) => boolean) {
      let cursor: string | null = null;
      let hasMore = true;
      while (hasMore) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res: any = await admin.graphql(
          `
          #graphql
          query FindBySku($query: String!, $after: String) {
            products(first: 250, query: $query, after: $after) {
              nodes {
                id
                title
                tags
                variants(first: 20) {
                  nodes { id sku }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { variables: { query: `sku:${searchTerm}`, after: cursor } },
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = await res.json();
        const nodes: any[] = data?.data?.products?.nodes ?? [];
        const pageInfo: { hasNextPage: boolean; endCursor: string } | undefined =
          data?.data?.products?.pageInfo;

        for (const product of nodes) {
          for (const variant of product.variants?.nodes ?? []) {
            if (onVariant(product, variant)) break;
          }
        }

        hasMore = pageInfo?.hasNextPage ?? false;
        cursor = pageInfo?.endCursor ?? null;
      }
    }

    for (const sku of skus) {
      try {
        const isCompound = sku.includes("+");
        let foundAnything = false;

        if (searchMode === "exact") {
          // ── Exact mode ──────────────────────────────────────────────────────
          // Keep multiplier values; only order is ignored.
          // "2X SKU-A + SKU-B" matches "SKU-B + 2X SKU-A" but NOT "SKU-A + SKU-B"
          const inputNormalized = sku
            .split("+")
            .map((p) => normalizeComponentExact(p))
            .filter(Boolean)
            .sort();

          if (inputNormalized.length === 0) { notFound.push(sku); continue; }

          // Strip multiplier only for the Shopify query term (to find candidates)
          const searchTerm = stripMultiplier(sku.split("+")[0]);
          await searchBySku(searchTerm, (product, variant) => {
            const variantNormalized = (variant.sku || "")
              .split("+")
              .map((p: string) => normalizeComponentExact(p))
              .filter(Boolean)
              .sort();
            const isMatch =
              variantNormalized.length === inputNormalized.length &&
              variantNormalized.every((c: string, i: number) => c === inputNormalized[i]);
            if (isMatch) {
              foundAnything = true;
              if (!matched.find((m) => m.id === product.id)) {
                matched.push({ id: product.id, title: product.title, sku: variant.sku, tags: product.tags ?? [] });
              }
              return true;
            }
            return false;
          });

        } else if (isCompound) {
          // ── Component mode, compound input ───────────────────────────────────
          // Strip multipliers; match any product whose variant contains exactly
          // this set of core SKUs (order-insensitive).
          const inputCores = sku
            .split("+")
            .map((p) => stripMultiplier(p))
            .filter(Boolean)
            .sort();

          if (inputCores.length === 0) { notFound.push(sku); continue; }

          await searchBySku(inputCores[0], (product, variant) => {
            const variantCores = variantCoreSkus(variant.sku || "").sort();
            const isMatch =
              variantCores.length === inputCores.length &&
              variantCores.every((c, i) => c === inputCores[i]);
            if (isMatch) {
              foundAnything = true;
              if (!matched.find((m) => m.id === product.id)) {
                matched.push({ id: product.id, title: product.title, sku: variant.sku, tags: product.tags ?? [] });
              }
              return true;
            }
            return false;
          });

        } else {
          // ── Component mode, single SKU ───────────────────────────────────────
          // Strip multiplier; find any product containing that core SKU as a component.
          const coreSku = stripMultiplier(sku);
          await searchBySku(coreSku, (product, variant) => {
            const cores = variantCoreSkus(variant.sku || "");
            if (cores.includes(coreSku)) {
              foundAnything = true;
              if (!matched.find((m) => m.id === product.id)) {
                matched.push({ id: product.id, title: product.title, sku: variant.sku, tags: product.tags ?? [] });
              }
              return true;
            }
            return false;
          });
        }

        if (!foundAnything) notFound.push(sku);
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

    // ── Fire-and-forget: process in background so the page can be left ──
    // Node.js keeps running this after the HTTP response is sent.
    (async () => {
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
            // Remove any conflicting "X off" tags before adding the new one
            if (DISCOUNT_TAG_RE.test(tag)) {
              const conflicting = product.tags.filter(
                (t: string) =>
                  DISCOUNT_TAG_RE.test(t) &&
                  t.toLowerCase() !== tag.toLowerCase(),
              );
              if (conflicting.length > 0) {
                await admin.graphql(
                  `#graphql
                  mutation TagsRemove($id: ID!, $tags: [String!]!) {
                    tagsRemove(id: $id, tags: $tags) {
                      userErrors { field message }
                    }
                  }`,
                  { variables: { id: product.id, tags: conflicting } },
                );
                // Respect Shopify rate limit between calls
                await new Promise((r) => setTimeout(r, 300));
              }
            }
            // Add tag
            if (!product.tags.includes(tag)) {
              await admin.graphql(
                `#graphql
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
                `#graphql
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

        // Rate-limit friendly: ~3 products/sec (Shopify allows ~5 calls/sec)
        await new Promise((r) => setTimeout(r, 350));

        // Persist progress every 10 products so History tab stays current
        if (i % 10 === 0 || i === products.length - 1) {
          await prisma.autoTagJob.update({
            where: { id: job.id },
            data: {
              processedCount: i + 1,
              changedCount,
              skippedProtectedCount: skippedProtected,
              changesJson: JSON.stringify(changes),
              errorsJson: JSON.stringify(errors),
            },
          }).catch(() => {});
        }
      }

      // Mark complete
      await prisma.autoTagJob.update({
        where: { id: job.id },
        data: {
          status: "completed",
          processedCount: products.length,
          changedCount,
          skippedProtectedCount: skippedProtected,
          changesJson: JSON.stringify(changes),
          errorsJson: JSON.stringify(errors),
        },
      }).catch(() => {});
    })().catch(console.error);

    // Return immediately — job runs in the background
    return json({
      ok: true,
      intent,
      jobId: job.id,
      message: `Job started: ${products.length} products queued. You can leave this page — check Job History for progress.`,
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
  const [searchMode, setSearchMode] = useState("component");

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
                    placeholder={"SKU-001\nSKU-002\n2X SKU-003 + SKU-004"}
                  />
                  <Select
                    label="Search Mode"
                    options={[
                      { label: "Component Search — find all products containing this SKU (multiplier ignored)", value: "component" },
                      { label: "Exact SKU Match — match this exact SKU with multiplier, any order", value: "exact" },
                    ]}
                    value={searchMode}
                    onChange={setSearchMode}
                  />
                  <Form method="post">
                    <input type="hidden" name="intent" value="match_skus" />
                    <input type="hidden" name="skus" value={skuInput} />
                    <input type="hidden" name="searchMode" value={searchMode} />
                    <Button submit loading={isSubmitting} variant="primary">
                      Match SKUs to Products
                    </Button>
                  </Form>
                </BlockStack>
              </Card>

              {/* Step 2: Review matches */}
              {matchedProducts.length > 0 && (
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">
                        Step 2: Review Matches
                      </Text>
                      <Badge tone="success">{matchedProducts.length} products found</Badge>
                    </InlineStack>
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
                      rows={matchedProducts.slice(0, 20).map((p) => [
                        p.title,
                        p.sku,
                        p.tags.length > 0 ? p.tags.join(", ") : "—",
                      ])}
                      truncate
                    />
                    {matchedProducts.length > 20 && (
                      <Text as="p" variant="bodyMd" tone="subdued">
                        Showing first 20 of {matchedProducts.length} matched products. All {matchedProducts.length} will be tagged in Step 3.
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
                    <Form method="post">
                      <input type="hidden" name="intent" value="clear_jobs" />
                      <Button
                        submit
                        loading={isSubmitting}
                        variant="plain"
                        tone="critical"
                      >
                        Clear History
                      </Button>
                    </Form>
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
