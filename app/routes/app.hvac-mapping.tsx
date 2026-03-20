import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation } from "@remix-run/react";
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
  Select,
  TextField,
  Divider,
  List,
  Tabs,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import unitsData from "../data/hvac/units.json";

// ── Types ──────────────────────────────────────────────────────────────────────

type UnitEntry = {
  Brand: string;
  Series: string;
  System: string;
  BTU: string;
  "Product ID": string;
  Refrigerant: string;
  URL: string;
  SKU: string;
};

type MappingRow = {
  id: number;
  sourceSku: string;
  sourceType: string | null;
  sourceBrand: string | null;
  sourceSeries: string | null;
  sourceSystem: string | null;
  sourceBtu: number | null;
  sourceRefrigerant: string | null;
  mappedProductId: string | null;
  mappedProductTitle: string | null;
  matchStatus: string;
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function classifySystem(system: string): "indoor" | "outdoor" {
  return system.toLowerCase().includes("outdoor") ? "outdoor" : "indoor";
}

const allUnits = (unitsData as any).indoorMapping as UnitEntry[];
const indoorUnits = allUnits.filter((u) => classifySystem(u.System) === "indoor");
const outdoorUnits = allUnits.filter((u) => classifySystem(u.System) === "outdoor");

// ── Loader ─────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const mappings = await prisma.hvacSkuMapping.findMany({
    where: { shop },
    orderBy: [{ sourceType: "asc" }, { sourceBrand: "asc" }, { sourceSku: "asc" }],
  });

  const stats = {
    total: mappings.length,
    indoor: mappings.filter((m) => m.sourceType === "indoor").length,
    outdoor: mappings.filter((m) => m.sourceType === "outdoor").length,
    mapped: mappings.filter((m) => m.matchStatus !== "unmapped" && m.matchStatus !== "not_found").length,
    unmapped: mappings.filter((m) => m.matchStatus === "unmapped" || m.matchStatus === "not_found").length,
    catalogIndoor: indoorUnits.length,
    catalogOutdoor: outdoorUnits.length,
  };

  return json({ mappings, stats, shop });
};

// ── Action ─────────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "");

  // ── Import from units.json ──
  if (intent === "import_catalog") {
    let created = 0;
    let skipped = 0;

    for (const unit of allUnits) {
      const sku = (unit.SKU || "").trim();
      if (!sku) continue;

      const sourceType = classifySystem(unit.System);
      try {
        await prisma.hvacSkuMapping.upsert({
          where: { shop_sourceSku: { shop, sourceSku: sku } },
          create: {
            shop,
            sourceSku: sku,
            sourceType,
            sourceBrand: unit.Brand || null,
            sourceSeries: unit.Series || null,
            sourceSystem: unit.System || null,
            sourceBtu: unit.BTU ? parseInt(unit.BTU, 10) || null : null,
            sourceRefrigerant: unit.Refrigerant || null,
            matchStatus: "unmapped",
          },
          update: {
            sourceType,
            sourceBrand: unit.Brand || null,
            sourceSeries: unit.Series || null,
            sourceSystem: unit.System || null,
            sourceBtu: unit.BTU ? parseInt(unit.BTU, 10) || null : null,
            sourceRefrigerant: unit.Refrigerant || null,
          },
        });
        created++;
      } catch {
        skipped++;
      }
    }

    return json({ ok: true, message: `Imported ${created} SKUs (${skipped} errors).` });
  }

  // ── Auto-match SKUs to Shopify products ──
  if (intent === "auto_match") {
    const unmapped = await prisma.hvacSkuMapping.findMany({
      where: { shop, matchStatus: "unmapped" },
    });

    let matched = 0;
    let notFound = 0;

    for (const row of unmapped) {
      try {
        const res = await admin.graphql(
          `
          #graphql
          query FindBySku($query: String!) {
            products(first: 5, query: $query) {
              nodes {
                id
                title
                handle
                onlineStoreUrl
                variants(first: 10) {
                  nodes { id sku }
                }
              }
            }
          }`,
          { variables: { query: `sku:${row.sourceSku}` } },
        );
        const data = await res.json();
        const products = data?.data?.products?.nodes ?? [];

        let found = false;
        for (const product of products) {
          for (const variant of product.variants?.nodes ?? []) {
            const vSku = (variant.sku || "").trim().toUpperCase();
            if (vSku === row.sourceSku.toUpperCase()) {
              await prisma.hvacSkuMapping.update({
                where: { id: row.id },
                data: {
                  mappedProductId: product.id,
                  mappedProductTitle: product.title,
                  mappedProductHandle: product.handle,
                  mappedProductUrl: product.onlineStoreUrl,
                  mappedVariantId: variant.id,
                  mappedVariantSku: variant.sku,
                  matchStatus: "auto_exact",
                },
              });
              matched++;
              found = true;
              break;
            }
          }
          if (found) break;
        }

        if (!found) {
          await prisma.hvacSkuMapping.update({
            where: { id: row.id },
            data: { matchStatus: "not_found" },
          });
          notFound++;
        }
      } catch {
        notFound++;
      }
    }

    return json({
      ok: true,
      message: `Auto-matched ${matched} products. ${notFound} not found.`,
    });
  }

  // ── Manual map ──
  if (intent === "manual_map") {
    const mappingId = Number(fd.get("mapping_id"));
    const productId = String(fd.get("product_id") ?? "").trim();

    if (!mappingId || !productId) {
      return json({ ok: false, message: "Missing mapping ID or product ID." });
    }

    // Look up the product in Shopify
    try {
      const gid = productId.startsWith("gid://")
        ? productId
        : `gid://shopify/Product/${productId}`;

      const res = await admin.graphql(
        `
        #graphql
        query GetProduct($id: ID!) {
          product(id: $id) {
            id title handle onlineStoreUrl
            variants(first: 5) { nodes { id sku } }
          }
        }`,
        { variables: { id: gid } },
      );
      const data = await res.json();
      const product = data?.data?.product;

      if (!product) {
        return json({ ok: false, message: `Product not found: ${productId}` });
      }

      await prisma.hvacSkuMapping.update({
        where: { id: mappingId },
        data: {
          mappedProductId: product.id,
          mappedProductTitle: product.title,
          mappedProductHandle: product.handle,
          mappedProductUrl: product.onlineStoreUrl,
          mappedVariantId: product.variants?.nodes?.[0]?.id ?? null,
          mappedVariantSku: product.variants?.nodes?.[0]?.sku ?? null,
          matchStatus: "manual",
        },
      });

      return json({ ok: true, message: `Mapped to ${product.title}` });
    } catch (err) {
      return json({
        ok: false,
        message: err instanceof Error ? err.message : "Failed to look up product.",
      });
    }
  }

  // ── Reset unmapped ──
  if (intent === "reset_not_found") {
    const count = await prisma.hvacSkuMapping.updateMany({
      where: { shop, matchStatus: "not_found" },
      data: { matchStatus: "unmapped" },
    });
    return json({ ok: true, message: `Reset ${count.count} not-found entries to unmapped.` });
  }

  // ── Clear all ──
  if (intent === "clear_all") {
    const count = await prisma.hvacSkuMapping.deleteMany({ where: { shop } });
    return json({ ok: true, message: `Deleted ${count.count} mappings.` });
  }

  return json({ ok: false, message: `Unknown intent: ${intent}` });
};

// ── Component ──────────────────────────────────────────────────────────────────

export default function HvacMappingRoute() {
  const { mappings, stats } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const [tabIdx, setTabIdx] = useState(0);
  const [filter, setFilter] = useState("all");
  const [manualId, setManualId] = useState("");
  const [manualProductId, setManualProductId] = useState("");

  const tabs = [
    { id: "overview", content: "Overview" },
    { id: "indoor", content: `Indoor (${stats.indoor})` },
    { id: "outdoor", content: `Outdoor (${stats.outdoor})` },
    { id: "manual", content: "Manual Map" },
  ];

  const filterOptions = [
    { label: "All", value: "all" },
    { label: "Mapped", value: "mapped" },
    { label: "Unmapped", value: "unmapped" },
    { label: "Not Found", value: "not_found" },
  ];

  const filterMappings = (type: "indoor" | "outdoor") => {
    let filtered = (mappings as MappingRow[]).filter((m) => m.sourceType === type);
    if (filter === "mapped") filtered = filtered.filter((m) => m.matchStatus === "auto_exact" || m.matchStatus === "manual");
    if (filter === "unmapped") filtered = filtered.filter((m) => m.matchStatus === "unmapped");
    if (filter === "not_found") filtered = filtered.filter((m) => m.matchStatus === "not_found");
    return filtered;
  };

  const statusBadge = (status: string) => {
    if (status === "auto_exact" || status === "manual")
      return <Badge tone="success">{status}</Badge>;
    if (status === "not_found") return <Badge tone="warning">not found</Badge>;
    return <Badge tone="attention">unmapped</Badge>;
  };

  const buildRows = (items: MappingRow[]) =>
    items.slice(0, 100).map((m) => [
      m.sourceSku,
      m.sourceBrand ?? "",
      m.sourceSystem ?? "",
      String(m.sourceBtu ?? ""),
      m.sourceRefrigerant ?? "",
      m.mappedProductTitle ?? "—",
      statusBadge(m.matchStatus),
    ]);

  return (
    <Page>
      <TitleBar title="HVAC SKU Mapping" />
      <Layout>
        {actionData && (
          <Layout.Section>
            <Banner tone={actionData.ok ? "success" : "critical"} title={actionData.message} />
          </Layout.Section>
        )}

        <Layout.Section>
          <Tabs tabs={tabs} selected={tabIdx} onSelect={setTabIdx} />
        </Layout.Section>

        {/* ── Overview Tab ── */}
        {tabIdx === 0 && (
          <Layout.Section>
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Catalog Stats</Text>
                  <List type="bullet">
                    <List.Item>
                      Catalog: {stats.catalogIndoor} indoor + {stats.catalogOutdoor} outdoor units in units.json
                    </List.Item>
                    <List.Item>
                      Database: {stats.total} mappings ({stats.indoor} indoor, {stats.outdoor} outdoor)
                    </List.Item>
                    <List.Item>
                      <Badge tone="success">{`${stats.mapped} matched`}</Badge>{" "}
                      <Badge tone="attention">{`${stats.unmapped} unmapped`}</Badge>
                    </List.Item>
                  </List>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Actions</Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Step 1: Import the HVAC catalog from units.json into the database.
                    Step 2: Auto-match SKUs to your Shopify products.
                  </Text>
                  <InlineStack gap="300" wrap>
                    <form method="post">
                      <input type="hidden" name="intent" value="import_catalog" />
                      <Button submit loading={isSubmitting} variant="primary">
                        Import Catalog from units.json
                      </Button>
                    </form>
                    <form method="post">
                      <input type="hidden" name="intent" value="auto_match" />
                      <Button submit loading={isSubmitting}>
                        Auto-Match SKUs to Shopify
                      </Button>
                    </form>
                    <form method="post">
                      <input type="hidden" name="intent" value="reset_not_found" />
                      <Button submit loading={isSubmitting} variant="plain">
                        Reset Not-Found → Unmapped
                      </Button>
                    </form>
                  </InlineStack>
                  <Divider />
                  <form method="post">
                    <input type="hidden" name="intent" value="clear_all" />
                    <Button submit loading={isSubmitting} variant="plain" tone="critical">
                      Clear All Mappings
                    </Button>
                  </form>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        )}

        {/* ── Indoor / Outdoor Tabs ── */}
        {(tabIdx === 1 || tabIdx === 2) && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">
                    {tabIdx === 1 ? "Indoor Units" : "Outdoor Condensers"}
                  </Text>
                  <Select
                    label="Filter"
                    labelHidden
                    options={filterOptions}
                    value={filter}
                    onChange={setFilter}
                  />
                </InlineStack>
                <DataTable
                  columnContentTypes={["text", "text", "text", "text", "text", "text", "text"]}
                  headings={["SKU", "Brand", "System", "BTU", "Refrigerant", "Mapped Product", "Status"]}
                  rows={buildRows(filterMappings(tabIdx === 1 ? "indoor" : "outdoor"))}
                  truncate
                />
                {filterMappings(tabIdx === 1 ? "indoor" : "outdoor").length > 100 && (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Showing first 100 of {filterMappings(tabIdx === 1 ? "indoor" : "outdoor").length} entries.
                  </Text>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* ── Manual Map Tab ── */}
        {tabIdx === 3 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Manual Map</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Enter the mapping ID (from the database) and the Shopify Product ID to manually
                  link a SKU to a product. Use this for SKUs that auto-match didn't find.
                </Text>
                <form method="post">
                  <input type="hidden" name="intent" value="manual_map" />
                  <BlockStack gap="300">
                    <TextField
                      label="Mapping ID"
                      type="number"
                      value={manualId}
                      onChange={setManualId}
                      name="mapping_id"
                      autoComplete="off"
                    />
                    <TextField
                      label="Shopify Product ID (numeric or gid://)"
                      value={manualProductId}
                      onChange={setManualProductId}
                      name="product_id"
                      autoComplete="off"
                    />
                    <Button submit loading={isSubmitting} variant="primary">
                      Map Product
                    </Button>
                  </BlockStack>
                </form>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}
