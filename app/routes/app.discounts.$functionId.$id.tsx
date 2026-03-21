import { useState, useRef } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Text,
  BlockStack,
  InlineStack,
  TextField,
  Select,
  Button,
  Banner,
  FormLayout,
  Divider,
  List,
  Checkbox,
  Badge,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// ── Types ─────────────────────────────────────────────────────────────────────

type CollectionOption = { id: string; title: string };
type SpendActivationMode =
  | "always"
  | "no_other_discounts"
  | "requires_any_xyz_active"
  | "requires_xyz_state";
type RuleConditionState = "any" | "active" | "inactive";

type ItemCollectionRule = {
  collection_id: string;
  percent: number;
};

type HvacCombinationRule = {
  name: string;
  enabled: boolean;
  outdoor_source_sku: string;
  outdoor_product_ids: string[];
  indoor_product_ids: string[];
  allowed_indoor_skus: string[];
  min_indoor_per_outdoor: number;
  max_indoor_per_outdoor: number;
  percent_off_hvac_products: number;
  amount_off_outdoor_per_bundle: number;
  stack_mode: "stackable" | "exclusive_best" | "independent" | "shared";
};

type HvacRule = {
  enabled: boolean;
  min_indoor_per_outdoor: number;
  max_indoor_per_outdoor: number;
  percent_off_hvac_products: number;
  amount_off_outdoor_per_bundle: number;
  indoor_product_ids: string[];
  outdoor_product_ids: string[];
  combination_rules: HvacCombinationRule[];
};

type SpendActivation = {
  mode: SpendActivationMode;
  required_any: Array<"bulk" | "vip" | "first">;
  xyz_operator: "and" | "or";
  bulk_state: RuleConditionState;
  vip_state: RuleConditionState;
  first_state: RuleConditionState;
};

type CollectionSpendRule = {
  enabled: boolean;
  collection_id: string;
  amount_off_per_step: number;
  min_collection_qty: number;
  spend_step_amount: number;
  max_discounted_units_per_order: number;
  product_ids: string[];
  activation: SpendActivation;
};

type HvacMappingEntry = {
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

type RuntimeConfig = {
  toggles: {
    first_order_enabled: boolean;
    bulk_enabled: boolean;
    vip_enabled: boolean;
    item_collection_enabled: boolean;
    collection_spend_enabled: boolean;
    hvac_enabled: boolean;
  };
  first_order_percent: number;
  bulk5_min: number;
  bulk5_percent: number;
  bulk10_min: number;
  bulk10_percent: number;
  bulk13_min: number;
  bulk13_percent: number;
  bulk15_min: number;
  bulk15_percent: number;
  item_collection_rules: ItemCollectionRule[];
  hvac_rule: HvacRule;
  collection_spend_rule: CollectionSpendRule;
  block_if_any_entered_discount_code: boolean;
  return_conflict_enabled: boolean;
  return_blocked_codes: string[];
};

type ActionResult = {
  ok: boolean;
  errors: string[];
  productCounts: Array<{ label: string; count: number }>;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const METAFIELD_BATCH_SIZE = 25; // Shopify metafieldsSet limit per call
const CONCURRENT_BATCH_GROUPS = 6; // 6 concurrent x 25 = 150 products at once

const DEFAULT_ACTIVATION: SpendActivation = {
  mode: "always",
  required_any: ["bulk"],
  xyz_operator: "or",
  bulk_state: "any",
  vip_state: "any",
  first_state: "any",
};

const DEFAULT_HVAC: HvacRule = {
  enabled: false,
  min_indoor_per_outdoor: 2,
  max_indoor_per_outdoor: 6,
  percent_off_hvac_products: 0,
  amount_off_outdoor_per_bundle: 0,
  indoor_product_ids: [],
  outdoor_product_ids: [],
  combination_rules: [],
};

const DEFAULT_SPEND: CollectionSpendRule = {
  enabled: false,
  collection_id: "",
  amount_off_per_step: 100,
  min_collection_qty: 1,
  spend_step_amount: 1500,
  max_discounted_units_per_order: 0,
  product_ids: [],
  activation: DEFAULT_ACTIVATION,
};

const DEFAULT_CONFIG: RuntimeConfig = {
  toggles: {
    first_order_enabled: true,
    bulk_enabled: true,
    vip_enabled: true,
    item_collection_enabled: true,
    collection_spend_enabled: false,
    hvac_enabled: false,
  },
  first_order_percent: 3,
  bulk5_min: 5000,
  bulk5_percent: 5,
  bulk10_min: 10000,
  bulk10_percent: 10,
  bulk13_min: 11000,
  bulk13_percent: 13,
  bulk15_min: 50000,
  bulk15_percent: 15,
  item_collection_rules: [],
  hvac_rule: DEFAULT_HVAC,
  collection_spend_rule: DEFAULT_SPEND,
  block_if_any_entered_discount_code: false,
  return_conflict_enabled: true,
  return_blocked_codes: ["RETURN"],
};

// ── Server helpers ─────────────────────────────────────────────────────────────

async function fetchCollections(admin: any): Promise<CollectionOption[]> {
  const res = await admin.graphql(`
    #graphql
    query FetchCollections {
      collections(first: 250, sortKey: TITLE) {
        nodes { id title }
      }
    }
  `);
  const data = await res.json();
  return data?.data?.collections?.nodes ?? [];
}

async function fetchAllProductIds(admin: any, collectionId: string): Promise<string[]> {
  if (!collectionId) return [];
  const ids: string[] = [];
  let after: string | null = null;
  while (true) {
    const res = await admin.graphql(
      `
      #graphql
      query CollectionProducts($id: ID!, $after: String) {
        collection(id: $id) {
          products(first: 250, after: $after) {
            nodes { id }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { variables: { id: collectionId, after } },
    );
    const data = await res.json();
    const block = data?.data?.collection?.products;
    if (!block) break;
    for (const node of block.nodes ?? []) {
      if (node?.id) ids.push(stripGid(String(node.id)));
    }
    if (!block.pageInfo?.hasNextPage) break;
    after = block.pageInfo.endCursor ?? null;
  }
  return ids;
}

type HvacCompatMapping = {
  sourceSku: string;
  sourceBrand?: string | null;
  sourceRefrigerant?: string | null;
};

function normalizeCompare(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

function stripGid(gid: string): string {
  return gid.replace("gid://shopify/Product/", "");
}

function isIndoorCompatibleWithOutdoor(
  indoor: HvacCompatMapping,
  outdoor: HvacCompatMapping,
): boolean {
  const indoorBrand = normalizeCompare(indoor.sourceBrand);
  const outdoorBrand = normalizeCompare(outdoor.sourceBrand);
  const indoorRef = normalizeCompare(indoor.sourceRefrigerant);
  const outdoorRef = normalizeCompare(outdoor.sourceRefrigerant);

  if (!indoorBrand || !outdoorBrand || !indoorRef || !outdoorRef) return false;
  return indoorBrand === outdoorBrand && indoorRef === outdoorRef;
}

// ── Loader ─────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const [collections, configRes, hvacMappings, discountRes] = await Promise.all([
    fetchCollections(admin),
    admin.graphql(`
      #graphql
      query ShopRuntimeConfig {
        shop {
          runtimeConfig: metafield(namespace: "smart_discount_engine", key: "config") { value }
          hvacConfig: metafield(namespace: "smart_discount_engine", key: "hvac_config") { value }
        }
      }
    `),
    prisma.hvacSkuMapping.findMany({
      where: { shop, matchStatus: { in: ["auto_exact", "manual"] } },
      orderBy: [{ sourceType: "asc" }, { sourceBrand: "asc" }, { sourceSku: "asc" }],
    }),
    admin.graphql(`
      #graphql
      query ActiveDiscounts {
        discountNodes(first: 50, query: "discount_type:app") {
          nodes {
            id
            discount {
              __typename
              ... on DiscountAutomaticApp {
                title
                status
              }
            }
          }
        }
      }
    `).then((r: any) => r.json()).catch((e: any) => {
      console.error("[diagnostics] discount query failed:", e?.message ?? e);
      return null;
    }),
  ]);

  const configData = await configRes.json();
  const shopData = configData?.data?.shop;
  const rawConfigValue = shopData?.runtimeConfig?.value ?? null;
  const rawHvacConfigValue = shopData?.hvacConfig?.value ?? null;

  let config: RuntimeConfig;
  try {
    config = rawConfigValue ? JSON.parse(rawConfigValue) : DEFAULT_CONFIG;
  } catch {
    config = DEFAULT_CONFIG;
  }

  // Merge HVAC combo rules from the separate hvac_config metafield back into config for display.
  if (rawHvacConfigValue) {
    try {
      const hvacOverlay = JSON.parse(rawHvacConfigValue);
      if (Array.isArray(hvacOverlay?.combination_rules)) {
        config.hvac_rule = { ...config.hvac_rule, combination_rules: hvacOverlay.combination_rules };
      }
    } catch { /* ignore parse errors */ }
  }

  // Separate indoor/outdoor mapped units
  const indoorMappings = hvacMappings
    .filter((m) => m.sourceType === "indoor" && m.mappedProductId)
    .map((m) => ({
      id: m.id,
      sourceSku: m.sourceSku,
      sourceType: m.sourceType,
      sourceBrand: m.sourceBrand,
      sourceSeries: m.sourceSeries,
      sourceSystem: m.sourceSystem,
      sourceBtu: m.sourceBtu,
      sourceRefrigerant: m.sourceRefrigerant,
      mappedProductId: m.mappedProductId,
      mappedProductTitle: m.mappedProductTitle,
      matchStatus: m.matchStatus,
    }));

  const outdoorMappings = hvacMappings
    .filter((m) => m.sourceType === "outdoor" && m.mappedProductId)
    .map((m) => ({
      id: m.id,
      sourceSku: m.sourceSku,
      sourceType: m.sourceType,
      sourceBrand: m.sourceBrand,
      sourceSeries: m.sourceSeries,
      sourceSystem: m.sourceSystem,
      sourceBtu: m.sourceBtu,
      sourceRefrigerant: m.sourceRefrigerant,
      mappedProductId: m.mappedProductId,
      mappedProductTitle: m.mappedProductTitle,
      matchStatus: m.matchStatus,
    }));

  // Extract active discount info for diagnostics
  const discountNodes = discountRes?.data?.discountNodes?.nodes ?? [];
  const activeAppDiscounts = discountNodes
    .filter((n: any) => {
      const d = n?.discount;
      return d?.__typename === "DiscountAutomaticApp" && d?.status === "ACTIVE";
    })
    .map((n: any) => ({
      id: n.id,
      title: n.discount.title ?? "Untitled",
      status: n.discount.status ?? "unknown",
    }));

  const configByteSize = (() => {
    try {
      return Buffer.byteLength(JSON.stringify(config), "utf8");
    } catch {
      return 0;
    }
  })();

  return json({
    config,
    collections,
    indoorMappings,
    outdoorMappings,
    diagnostics: {
      activeAppDiscounts,
      hasMetafield: Boolean(rawConfigValue),
      configByteSize,
      keyValues: {
        first_order_enabled: config.toggles.first_order_enabled,
        first_order_percent: config.first_order_percent,
        bulk_enabled: config.toggles.bulk_enabled,
        bulk5_min: config.bulk5_min,
        bulk5_percent: config.bulk5_percent,
        bulk10_min: config.bulk10_min,
        bulk10_percent: config.bulk10_percent,
        bulk13_min: config.bulk13_min,
        bulk13_percent: config.bulk13_percent,
        bulk15_min: config.bulk15_min,
        bulk15_percent: config.bulk15_percent,
        vip_enabled: config.toggles.vip_enabled,
        item_collection_enabled: config.toggles.item_collection_enabled,
        item_rule_count: config.item_collection_rules.length,
        hvac_enabled: config.toggles.hvac_enabled,
        hvac_indoor_ids: config.hvac_rule.indoor_product_ids.length,
        hvac_outdoor_ids: config.hvac_rule.outdoor_product_ids.length,
        hvac_combo_rules: config.hvac_rule.combination_rules?.length ?? 0,
      },
    },
  });
};

// ── Action ─────────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const fd = await request.formData();

  const configJson = String(fd.get("config_json") ?? "{}");
  let parsed: RuntimeConfig;
  try {
    parsed = JSON.parse(configJson) as RuntimeConfig;
  } catch {
    return json<ActionResult>({ ok: false, errors: ["Invalid config JSON."], productCounts: [] });
  }

  const productCounts: ActionResult["productCounts"] = [];

  // Fetch product IDs for item collection rules — used for product metafield writes,
  // NOT stored in config (config only stores collection_id + percent).
  const itemRulesWithProducts = await Promise.all(
    (parsed.item_collection_rules ?? []).map(async (rule) => {
      const product_ids = await fetchAllProductIds(admin, rule.collection_id);
      productCounts.push({ label: `Item rule (${rule.percent}%)`, count: product_ids.length });
      return { collection_id: rule.collection_id, percent: rule.percent, product_ids };
    }),
  );
  // Config only keeps collection_id + percent (no product_ids)
  const item_collection_rules: ItemCollectionRule[] = itemRulesWithProducts.map(
    ({ collection_id, percent }) => ({ collection_id, percent }),
  );

  // Pull HVAC product IDs from the mapping database (not collections)
  const hvacBase = parsed.hvac_rule ?? DEFAULT_HVAC;
  const allHvacMappings = await prisma.hvacSkuMapping.findMany({
    where: { shop, matchStatus: { in: ["auto_exact", "manual"] }, mappedProductId: { not: null } },
  });

  const indoorIds: string[] = [
    ...new Set(
      allHvacMappings
        .filter((m) => m.sourceType === "indoor" && m.mappedProductId)
        .map((m) => stripGid(m.mappedProductId as string)),
    ),
  ];
  const outdoorIds: string[] = [
    ...new Set(
      allHvacMappings
        .filter((m) => m.sourceType === "outdoor" && m.mappedProductId)
        .map((m) => stripGid(m.mappedProductId as string)),
    ),
  ];

  productCounts.push({ label: "HVAC indoor (from mapping)", count: indoorIds.length });
  productCounts.push({ label: "HVAC outdoor (from mapping)", count: outdoorIds.length });

  // Build a SKU → product ID lookup for combination rules
  const skuToProductId = new Map<string, string>();
  const indoorBySku = new Map<string, (typeof allHvacMappings)[number]>();
  const outdoorBySku = new Map<string, (typeof allHvacMappings)[number]>();
  for (const m of allHvacMappings) {
    if (m.mappedProductId) {
      const skuKey = normalizeCompare(m.sourceSku);
      skuToProductId.set(skuKey, stripGid(m.mappedProductId));
      if (m.sourceType === "indoor") indoorBySku.set(skuKey, m);
      if (m.sourceType === "outdoor") outdoorBySku.set(skuKey, m);
    }
  }

  // Resolve combination rules: convert SKUs to product IDs
  const combination_rules = (hvacBase.combination_rules ?? []).map((rule) => {
    const outdoorSkuKey = normalizeCompare(rule.outdoor_source_sku);
    const outdoorMapping = outdoorSkuKey ? outdoorBySku.get(outdoorSkuKey) : undefined;
    const outdoorPid = outdoorSkuKey
      ? skuToProductId.get(outdoorSkuKey)
      : undefined;

    const compatibleIndoorSkuSet = new Set(
      outdoorMapping
        ? Array.from(indoorBySku.values())
            .filter((indoor) => isIndoorCompatibleWithOutdoor(indoor, outdoorMapping))
            .map((indoor) => normalizeCompare(indoor.sourceSku))
        : [],
    );

    const requestedIndoorSkus = (rule.allowed_indoor_skus ?? []).map((sku: string) =>
      normalizeCompare(sku),
    );

    const effectiveIndoorSkus =
      compatibleIndoorSkuSet.size > 0
        ? requestedIndoorSkus.length > 0
          ? requestedIndoorSkus.filter((sku) => compatibleIndoorSkuSet.has(sku))
          : Array.from(compatibleIndoorSkuSet)
        : [];

    return {
      ...rule,
      outdoor_product_ids: outdoorPid ? [outdoorPid] : [] as string[],
      indoor_product_ids: effectiveIndoorSkus
        .map((sku: string) => skuToProductId.get(sku))
        .filter((x): x is string => Boolean(x)),
    };
  });

  const hvac_rule: HvacRule = {
    ...hvacBase,
    indoor_product_ids: indoorIds,
    outdoor_product_ids: outdoorIds,
    combination_rules,
  };

  // Fetch product IDs for collection spend rule
  const spendBase = parsed.collection_spend_rule ?? DEFAULT_SPEND;
  const spendIds = await fetchAllProductIds(admin, spendBase.collection_id ?? "");
  if (spendIds.length > 0) productCounts.push({ label: "Collection spend", count: spendIds.length });

  const collection_spend_rule: CollectionSpendRule = {
    ...spendBase,
    product_ids: spendIds,
    activation: {
      ...DEFAULT_ACTIVATION,
      ...(spendBase.activation ?? {}),
    },
  };

  const fullConfig: RuntimeConfig = {
    ...parsed,
    item_collection_rules,
    hvac_rule,
    collection_spend_rule,
  };

  // Split HVAC combo rules into a separate shop metafield to keep main config < 10KB.
  // Shopify Functions null metafield values larger than ~10KB in their input.
  const { combination_rules: hvacComboRules, ...hvacRuleWithoutCombos } = fullConfig.hvac_rule;
  const mainConfig = { ...fullConfig, hvac_rule: { ...hvacRuleWithoutCombos, combination_rules: [] } };
  const hvacConfigPayload = { combination_rules: hvacComboRules };

  const serializedConfig = JSON.stringify(mainConfig);
  const serializedHvacConfig = JSON.stringify(hvacConfigPayload);
  const configSize = Buffer.byteLength(serializedConfig, "utf8");
  const hvacConfigSize = Buffer.byteLength(serializedHvacConfig, "utf8");
  productCounts.push({ label: "Config size (bytes)", count: configSize });
  productCounts.push({ label: "HVAC config size (bytes)", count: hvacConfigSize });

  // Get shop GID for shop-level metafields
  const shopRes = await admin.graphql(`
    #graphql
    query GetShopId {
      shop { id }
    }
  `);
  const shopGql = await shopRes.json();
  const shopId = shopGql?.data?.shop?.id as string | undefined;

  if (!shopId) {
    return json<ActionResult>({ ok: false, errors: ["Could not resolve shop ID."], productCounts });
  }

  const errors: string[] = [];

  // 1. Save main config + HVAC config to separate shop metafields.
  //    Main config stays < 10KB (Shopify Functions null values above ~10KB).
  //    HVAC combo rules are split into hvac_config metafield, read only when HVAC is enabled.
  const [saveRes, hvacSaveRes] = await Promise.all([
    admin.graphql(
      `#graphql
      mutation SaveRuntimeConfig($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              ownerId: shopId,
              namespace: "smart_discount_engine",
              key: "config",
              type: "multi_line_text_field",
              value: serializedConfig,
            },
          ],
        },
      },
    ),
    admin.graphql(
      `#graphql
      mutation SaveHvacConfig($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              ownerId: shopId,
              namespace: "smart_discount_engine",
              key: "hvac_config",
              type: "multi_line_text_field",
              value: serializedHvacConfig,
            },
          ],
        },
      },
    ),
  ]);
  const saveData = await saveRes.json();
  for (const e of saveData?.data?.metafieldsSet?.userErrors ?? []) {
    errors.push(String(e?.message ?? "Unknown error"));
  }
  const hvacSaveData = await hvacSaveRes.json();
  for (const e of hvacSaveData?.data?.metafieldsSet?.userErrors ?? []) {
    errors.push(`HVAC config: ${e?.message ?? "Unknown error"}`);
  }

  // 2. Batch-set discount_percent metafield on each product in item rules.
  //    The Shopify Function reads this metafield directly from cart line products.
  const productPercentMap = new Map<string, number>();
  for (const rule of itemRulesWithProducts) {
    for (const pid of rule.product_ids) {
      const existing = productPercentMap.get(pid) ?? 0;
      productPercentMap.set(pid, Math.max(existing, rule.percent));
    }
  }

  const productEntries = Array.from(productPercentMap.entries());
  const currentProductIdSet = new Set(productPercentMap.keys());

  // ── Stale metafield cleanup ─────────────────────────────────────────────────
  // Query all products that currently have a discount_percent metafield set,
  // then zero out any that are no longer in any active collection rule.
  {
    let staleCursor: string | null = null;
    const staleIds: string[] = [];
    do {
      const staleRes = await admin.graphql(
        `#graphql
        query StaleDiscountProducts($cursor: String) {
          products(first: 250, after: $cursor, query: "metafields_namespace_and_key:smart_discount_engine.discount_percent") {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              discountPercent: metafield(namespace: "smart_discount_engine", key: "discount_percent") { value }
            }
          }
        }`,
        { variables: { cursor: staleCursor } },
      );
      const staleData = await staleRes.json();
      const nodes = staleData?.data?.products?.nodes ?? [];
      for (const node of nodes) {
        const rawId = (node.id as string).replace("gid://shopify/Product/", "");
        const hasDiscount = Number(node.discountPercent?.value ?? 0) > 0;
        if (hasDiscount && !currentProductIdSet.has(rawId)) {
          staleIds.push(node.id as string);
        }
      }
      const pageInfo = staleData?.data?.products?.pageInfo;
      staleCursor = pageInfo?.hasNextPage ? pageInfo.endCursor : null;
    } while (staleCursor);

    // Zero out stale products in parallel batches
    if (staleIds.length > 0) {
      productCounts.push({ label: "Stale metafields cleared", count: staleIds.length });
      const staleBatches: string[][] = [];
      for (let i = 0; i < staleIds.length; i += METAFIELD_BATCH_SIZE) {
        staleBatches.push(staleIds.slice(i, i + METAFIELD_BATCH_SIZE));
      }
      for (let g = 0; g < staleBatches.length; g += CONCURRENT_BATCH_GROUPS) {
        await Promise.all(
          staleBatches.slice(g, g + CONCURRENT_BATCH_GROUPS).map(async (batch) => {
            const metafields = batch.map((pid) => ({
              ownerId: pid,
              namespace: "smart_discount_engine",
              key: "discount_percent",
              type: "number_decimal",
              value: "0",
            }));
            try {
              await admin.graphql(
                `#graphql
                mutation ClearStaleDiscountPercent($metafields: [MetafieldsSetInput!]!) {
                  metafieldsSet(metafields: $metafields) {
                    userErrors { field message }
                  }
                }`,
                { variables: { metafields } },
              );
            } catch (_) { /* best-effort */ }
          }),
        );
      }
    }
  }

  // ── Write current discount_percent metafields in parallel ───────────────────
  const allBatches: Array<Array<[string, number]>> = [];
  for (let i = 0; i < productEntries.length; i += METAFIELD_BATCH_SIZE) {
    allBatches.push(productEntries.slice(i, i + METAFIELD_BATCH_SIZE));
  }

  let metafieldWriteCount = 0;
  for (let g = 0; g < allBatches.length; g += CONCURRENT_BATCH_GROUPS) {
    const groupResults = await Promise.all(
      allBatches.slice(g, g + CONCURRENT_BATCH_GROUPS).map(async (batch) => {
        const metafields = batch.map(([pid, pct]) => ({
          ownerId: `gid://shopify/Product/${pid}`,
          namespace: "smart_discount_engine",
          key: "discount_percent",
          type: "number_decimal",
          value: String(pct),
        }));
        try {
          const batchRes = await admin.graphql(
            `#graphql
            mutation SetProductDiscountPercent($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) {
                userErrors { field message }
              }
            }`,
            { variables: { metafields } },
          );
          const batchData = await batchRes.json();
          const batchErrors: string[] = (batchData?.data?.metafieldsSet?.userErrors ?? []).map(
            (e: any) => `Product metafield: ${e?.message ?? "Unknown error"}`,
          );
          return { count: batch.length, errors: batchErrors };
        } catch (err) {
          return {
            count: 0,
            errors: [`Product metafield batch error: ${err instanceof Error ? err.message : String(err)}`],
          };
        }
      }),
    );
    for (const result of groupResults) {
      metafieldWriteCount += result.count;
      for (const e of result.errors) errors.push(e);
    }
  }

  productCounts.push({ label: "Product metafields written", count: metafieldWriteCount });

  return json<ActionResult>({ ok: errors.length === 0, errors, productCounts });
};

// ── Component ──────────────────────────────────────────────────────────────────

type Section = "order" | "item" | "hvac" | "spend" | "status";
type RuleState = { collection_id: string; percent: string };

type CombinationRuleState = {
  name: string;
  enabled: boolean;
  outdoor_source_sku: string;
  allowed_indoor_skus: string[];
  min_indoor_per_outdoor: string;
  max_indoor_per_outdoor: string;
  percent_off_hvac_products: string;
  amount_off_outdoor_per_bundle: string;
  stack_mode: string;
};

export default function DiscountConfigRoute() {
  const { config, collections, indoorMappings, outdoorMappings, diagnostics } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const indoorMappingEntries = indoorMappings as HvacMappingEntry[];
  const outdoorMappingEntries = outdoorMappings as HvacMappingEntry[];

  const formRef = useRef<HTMLFormElement>(null);
  const configInputRef = useRef<HTMLInputElement>(null);

  // Toggles
  const [toggleFirstOrder, setToggleFirstOrder] = useState(config.toggles.first_order_enabled);
  const [toggleBulk, setToggleBulk] = useState(config.toggles.bulk_enabled);
  const [toggleVip, setToggleVip] = useState(config.toggles.vip_enabled);
  const [toggleItem, setToggleItem] = useState(config.toggles.item_collection_enabled);
  const [toggleSpend, setToggleSpend] = useState(config.toggles.collection_spend_enabled);
  const [toggleHvac, setToggleHvac] = useState(config.toggles.hvac_enabled);

  // Order rules
  const [firstOrderPct, setFirstOrderPct] = useState(String(config.first_order_percent));
  const [bulk5Min, setBulk5Min] = useState(String(config.bulk5_min));
  const [bulk5Pct, setBulk5Pct] = useState(String(config.bulk5_percent));
  const [bulk10Min, setBulk10Min] = useState(String(config.bulk10_min));
  const [bulk10Pct, setBulk10Pct] = useState(String(config.bulk10_percent));
  const [bulk13Min, setBulk13Min] = useState(String(config.bulk13_min));
  const [bulk13Pct, setBulk13Pct] = useState(String(config.bulk13_percent));
  const [bulk15Min, setBulk15Min] = useState(String(config.bulk15_min));
  const [bulk15Pct, setBulk15Pct] = useState(String(config.bulk15_percent));

  // Global conflict settings
  const [blockIfCode, setBlockIfCode] = useState(config.block_if_any_entered_discount_code);
  const [returnConflict, setReturnConflict] = useState(config.return_conflict_enabled);
  const [returnCodes, setReturnCodes] = useState(config.return_blocked_codes.join(","));

  // Item rules
  const [rules, setRules] = useState<RuleState[]>(
    config.item_collection_rules.map((r) => ({
      collection_id: r.collection_id,
      percent: String(r.percent),
    })),
  );

  // HVAC rules (global defaults)
  const [hvacMinIndoor, setHvacMinIndoor] = useState(String(config.hvac_rule.min_indoor_per_outdoor));
  const [hvacMaxIndoor, setHvacMaxIndoor] = useState(String(config.hvac_rule.max_indoor_per_outdoor));
  const [hvacPercent, setHvacPercent] = useState(String(config.hvac_rule.percent_off_hvac_products));
  const [hvacAmountOff, setHvacAmountOff] = useState(
    String(config.hvac_rule.amount_off_outdoor_per_bundle),
  );

  // HVAC combination rules (per-condenser)
  const [comboRules, setComboRules] = useState<CombinationRuleState[]>(
    (config.hvac_rule.combination_rules ?? []).map((r: any) => ({
      // Normalize older values ("independent"/"shared") to the current runtime modes.
      // Any non-exclusive mode behaves as stackable in the function.
      stack_mode:
        String(r.stack_mode ?? "").trim() === "exclusive_best"
          ? "exclusive_best"
          : "stackable",
      name: r.name ?? "",
      enabled: r.enabled ?? true,
      outdoor_source_sku: r.outdoor_source_sku ?? "",
      allowed_indoor_skus: r.allowed_indoor_skus ?? [],
      min_indoor_per_outdoor: String(r.min_indoor_per_outdoor ?? 2),
      max_indoor_per_outdoor: String(r.max_indoor_per_outdoor ?? 6),
      percent_off_hvac_products: String(r.percent_off_hvac_products ?? 0),
      amount_off_outdoor_per_bundle: String(r.amount_off_outdoor_per_bundle ?? 0),
    })),
  );

  // Collection spend rule
  const [spendCollection, setSpendCollection] = useState(config.collection_spend_rule.collection_id);
  const [spendAmtPerStep, setSpendAmtPerStep] = useState(
    String(config.collection_spend_rule.amount_off_per_step),
  );
  const [spendMinQty, setSpendMinQty] = useState(
    String(config.collection_spend_rule.min_collection_qty),
  );
  const [spendStepAmount, setSpendStepAmount] = useState(
    String(config.collection_spend_rule.spend_step_amount),
  );
  const [spendMaxUnits, setSpendMaxUnits] = useState(
    String(config.collection_spend_rule.max_discounted_units_per_order ?? 0),
  );

  // Spend activation (X/Y/Z rule)
  const act = config.collection_spend_rule.activation;
  const [spendMode, setSpendMode] = useState<SpendActivationMode>(act.mode);
  const [spendReqBulk, setSpendReqBulk] = useState(act.required_any.includes("bulk"));
  const [spendReqVip, setSpendReqVip] = useState(act.required_any.includes("vip"));
  const [spendReqFirst, setSpendReqFirst] = useState(act.required_any.includes("first"));
  const [spendXyzOp, setSpendXyzOp] = useState<"and" | "or">(act.xyz_operator);
  const [spendBulkState, setSpendBulkState] = useState<RuleConditionState>(act.bulk_state);
  const [spendVipState, setSpendVipState] = useState<RuleConditionState>(act.vip_state);
  const [spendFirstState, setSpendFirstState] = useState<RuleConditionState>(act.first_state);

  const [section, setSection] = useState<Section>("order");

  const getCompatibleIndoorMappings = (outdoorSku: string): HvacMappingEntry[] => {
    const outdoor = outdoorMappingEntries.find(
      (m) => normalizeCompare(m.sourceSku) === normalizeCompare(outdoorSku),
    );
    if (!outdoor) return [];
    return indoorMappingEntries.filter((indoor) =>
      isIndoorCompatibleWithOutdoor(indoor, outdoor),
    );
  };

  const collectionOptions = [
    { label: "— Select collection —", value: "" },
    ...collections.map((c: CollectionOption) => ({ label: c.title, value: c.id })),
  ];

  const handleSubmit = (_e: React.FormEvent<HTMLFormElement>) => {
    if (!configInputRef.current) return;
    const built: RuntimeConfig = {
      toggles: {
        first_order_enabled: toggleFirstOrder,
        bulk_enabled: toggleBulk,
        vip_enabled: toggleVip,
        item_collection_enabled: toggleItem,
        collection_spend_enabled: toggleSpend,
        hvac_enabled: toggleHvac,
      },
      first_order_percent: Number(firstOrderPct) || 0,
      bulk5_min: Number(bulk5Min) || 0,
      bulk5_percent: Number(bulk5Pct) || 0,
      bulk10_min: Number(bulk10Min) || 0,
      bulk10_percent: Number(bulk10Pct) || 0,
      bulk13_min: Number(bulk13Min) || 0,
      bulk13_percent: Number(bulk13Pct) || 0,
      bulk15_min: Number(bulk15Min) || 0,
      bulk15_percent: Number(bulk15Pct) || 0,
      item_collection_rules: rules
        .filter((r) => r.collection_id && Number(r.percent) > 0)
        .map((r) => ({ collection_id: r.collection_id, percent: Number(r.percent) })),
      hvac_rule: {
        enabled: toggleHvac,
        min_indoor_per_outdoor: Number(hvacMinIndoor) || 2,
        max_indoor_per_outdoor: Number(hvacMaxIndoor) || 6,
        percent_off_hvac_products: Number(hvacPercent) || 0,
        amount_off_outdoor_per_bundle: Number(hvacAmountOff) || 0,
        indoor_product_ids: [],
        outdoor_product_ids: [],
        combination_rules: comboRules.map((r) => ({
          name: r.name,
          enabled: r.enabled,
          outdoor_source_sku: r.outdoor_source_sku,
          allowed_indoor_skus: r.allowed_indoor_skus,
          outdoor_product_ids: [] as string[],
          indoor_product_ids: [] as string[],
          min_indoor_per_outdoor: Number(r.min_indoor_per_outdoor) || 2,
          max_indoor_per_outdoor: Number(r.max_indoor_per_outdoor) || 6,
          percent_off_hvac_products: Number(r.percent_off_hvac_products) || 0,
          amount_off_outdoor_per_bundle: Number(r.amount_off_outdoor_per_bundle) || 0,
          stack_mode: r.stack_mode as HvacCombinationRule["stack_mode"],
        })),
      },
      collection_spend_rule: {
        enabled: toggleSpend,
        collection_id: spendCollection,
        amount_off_per_step: Number(spendAmtPerStep) || 0,
        min_collection_qty: Number(spendMinQty) || 1,
        spend_step_amount: Number(spendStepAmount) || 0,
        max_discounted_units_per_order: Number(spendMaxUnits) || 0,
        product_ids: [],
        activation: {
          mode: spendMode,
          required_any: [
            ...(spendReqBulk ? (["bulk"] as const) : []),
            ...(spendReqVip ? (["vip"] as const) : []),
            ...(spendReqFirst ? (["first"] as const) : []),
          ],
          xyz_operator: spendXyzOp,
          bulk_state: spendBulkState,
          vip_state: spendVipState,
          first_state: spendFirstState,
        },
      },
      block_if_any_entered_discount_code: blockIfCode,
      return_conflict_enabled: returnConflict,
      return_blocked_codes: returnCodes
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    };
    configInputRef.current.value = JSON.stringify(built);
  };

  const SECTIONS: { key: Section; label: string }[] = [
    { key: "order", label: "Order Rules" },
    { key: "item", label: "Item Rules" },
    { key: "hvac", label: "HVAC Rules" },
    { key: "spend", label: "Spend Rules" },
    { key: "status", label: "Status" },
  ];

  const stateOptions: Array<{ label: string; value: RuleConditionState }> = [
    { label: "Any", value: "any" },
    { label: "Active", value: "active" },
    { label: "Inactive", value: "inactive" },
  ];

  const showXyzOptions =
    spendMode === "requires_any_xyz_active" || spendMode === "requires_xyz_state";

  return (
    <Page>
      <TitleBar title="Smart Discount Engine — Configure" />
      <form method="post" ref={formRef} onSubmit={handleSubmit}>
        <input type="hidden" name="config_json" ref={configInputRef} />
        <Layout>
          {/* Banners */}
          {actionData?.ok === true && (
            <Layout.Section>
              <Banner tone="success" title="Config saved!">
                <List type="bullet">
                  <List.Item>Function will use updated rules on next cart load.</List.Item>
                  {actionData.productCounts.map((pc, i) => (
                    <List.Item key={i}>
                      {pc.count} products → {pc.label}
                    </List.Item>
                  ))}
                </List>
              </Banner>
            </Layout.Section>
          )}
          {actionData?.ok === false && (
            <Layout.Section>
              <Banner tone="critical" title="Save failed">
                <List type="bullet">
                  {actionData.errors.map((e, i) => (
                    <List.Item key={i}>{e}</List.Item>
                  ))}
                </List>
              </Banner>
            </Layout.Section>
          )}

          {/* Toggles */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Discount Toggles
                </Text>
                <InlineStack gap="400" wrap>
                  <Checkbox label="First Order" checked={toggleFirstOrder} onChange={setToggleFirstOrder} />
                  <Checkbox label="Bulk" checked={toggleBulk} onChange={setToggleBulk} />
                  <Checkbox label="VIP (VIP3–VIP25)" checked={toggleVip} onChange={setToggleVip} />
                  <Checkbox label="Item Collection" checked={toggleItem} onChange={setToggleItem} />
                  <Checkbox label="HVAC" checked={toggleHvac} onChange={setToggleHvac} />
                  <Checkbox label="X/Y/Z Spend Rule" checked={toggleSpend} onChange={setToggleSpend} />
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* Section tabs */}
          <Layout.Section>
            <InlineStack gap="200" wrap>
              {SECTIONS.map(({ key, label }) => (
                <Button
                  key={key}
                  variant={section === key ? "primary" : "secondary"}
                  onClick={() => setSection(key)}
                >
                  {label}
                </Button>
              ))}
            </InlineStack>
          </Layout.Section>

          {/* ── Order Rules ── */}
          {section === "order" && (
            <Layout.Section>
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="400">
                    <Text as="h3" variant="headingSm">
                      First Order Discount
                    </Text>
                    <TextField
                      label="Discount % for first-time customers"
                      type="number"
                      value={firstOrderPct}
                      onChange={setFirstOrderPct}
                      autoComplete="off"
                    />
                    <Divider />
                    <Text as="h3" variant="headingSm">
                      Bulk Tiers — by order subtotal ($)
                    </Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Customer gets the highest tier their subtotal qualifies for.
                    </Text>
                    <FormLayout>
                      <FormLayout.Group>
                        <TextField label="Tier 1 Min $" type="number" value={bulk5Min} onChange={setBulk5Min} autoComplete="off" />
                        <TextField label="Tier 1 %" type="number" value={bulk5Pct} onChange={setBulk5Pct} autoComplete="off" />
                      </FormLayout.Group>
                      <FormLayout.Group>
                        <TextField label="Tier 2 Min $" type="number" value={bulk10Min} onChange={setBulk10Min} autoComplete="off" />
                        <TextField label="Tier 2 %" type="number" value={bulk10Pct} onChange={setBulk10Pct} autoComplete="off" />
                      </FormLayout.Group>
                      <FormLayout.Group>
                        <TextField label="Tier 3 Min $" type="number" value={bulk13Min} onChange={setBulk13Min} autoComplete="off" />
                        <TextField label="Tier 3 %" type="number" value={bulk13Pct} onChange={setBulk13Pct} autoComplete="off" />
                      </FormLayout.Group>
                      <FormLayout.Group>
                        <TextField label="Tier 4 Min $" type="number" value={bulk15Min} onChange={setBulk15Min} autoComplete="off" />
                        <TextField label="Tier 4 %" type="number" value={bulk15Pct} onChange={setBulk15Pct} autoComplete="off" />
                      </FormLayout.Group>
                    </FormLayout>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">
                      Discount Code Conflict Settings
                    </Text>
                    <Checkbox
                      label="Block app discounts if customer has already entered a discount code"
                      checked={blockIfCode}
                      onChange={setBlockIfCode}
                    />
                    <Checkbox
                      label="Prevent stacking with Return/exchange discount codes"
                      checked={returnConflict}
                      onChange={setReturnConflict}
                    />
                    {returnConflict && (
                      <TextField
                        label="Blocked codes (comma-separated)"
                        value={returnCodes}
                        onChange={setReturnCodes}
                        helpText="e.g. RETURN,EXCHANGE — app discount will not apply when these codes are active"
                        autoComplete="off"
                      />
                    )}
                  </BlockStack>
                </Card>
              </BlockStack>
            </Layout.Section>
          )}

          {/* ── Item Rules ── */}
          {section === "item" && (
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text as="h3" variant="headingSm">
                    Item Collection Rules
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Products in the selected collection get the specified discount %. On save, a
                    discount_percent metafield is set on each product for the checkout function to read.
                  </Text>
                  {rules.map((rule, i) => (
                    <Card key={`rule-${i}`}>
                      <BlockStack gap="200">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="h4" variant="headingSm">
                            Rule {i + 1}
                          </Text>
                          <Button
                            variant="plain"
                            tone="critical"
                            onClick={() => setRules((p) => p.filter((_, j) => j !== i))}
                          >
                            Remove
                          </Button>
                        </InlineStack>
                        <Select
                          label="Collection"
                          options={collectionOptions}
                          value={rule.collection_id}
                          onChange={(v) =>
                            setRules((p) => p.map((r, j) => (j === i ? { ...r, collection_id: v } : r)))
                          }
                        />
                        <TextField
                          label="Discount %"
                          type="number"
                          value={rule.percent}
                          onChange={(v) =>
                            setRules((p) => p.map((r, j) => (j === i ? { ...r, percent: v } : r)))
                          }
                          autoComplete="off"
                        />
                      </BlockStack>
                    </Card>
                  ))}
                  <Button
                    onClick={() =>
                      setRules((p) => [...p, { collection_id: "", percent: "5" }])
                    }
                  >
                    + Add Rule
                  </Button>
                </BlockStack>
              </Card>
            </Layout.Section>
          )}

          {/* ── HVAC Rules ── */}
          {section === "hvac" && (
            <Layout.Section>
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="400">
                    <Text as="h3" variant="headingSm">
                      HVAC Bundle Rules
                    </Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Product IDs come from the HVAC Mapping page (SKU-based matching, not collections).
                      Go to HVAC Mapping to import your catalog and match SKUs to Shopify products first.
                    </Text>
                    <InlineStack gap="400">
                      <Badge tone="info">{`${(indoorMappings as HvacMappingEntry[]).length} indoor mapped`}</Badge>
                      <Badge tone="info">{`${(outdoorMappings as HvacMappingEntry[]).length} outdoor mapped`}</Badge>
                    </InlineStack>
                    <Divider />
                    <Text as="h4" variant="headingSm">
                      Global Defaults (apply when no combination rule matches)
                    </Text>
                    <FormLayout>
                      <FormLayout.Group>
                        <TextField
                          label="Min indoor heads per outdoor unit"
                          type="number"
                          value={hvacMinIndoor}
                          onChange={setHvacMinIndoor}
                          autoComplete="off"
                        />
                        <TextField
                          label="Max indoor heads per outdoor unit"
                          type="number"
                          value={hvacMaxIndoor}
                          onChange={setHvacMaxIndoor}
                          autoComplete="off"
                        />
                      </FormLayout.Group>
                      <FormLayout.Group>
                        <TextField
                          label="% off HVAC products in bundle"
                          type="number"
                          value={hvacPercent}
                          onChange={setHvacPercent}
                          autoComplete="off"
                        />
                        <TextField
                          label="$ off per outdoor unit"
                          type="number"
                          value={hvacAmountOff}
                          onChange={setHvacAmountOff}
                          autoComplete="off"
                        />
                      </FormLayout.Group>
                    </FormLayout>
                  </BlockStack>
                </Card>

                {/* Per-condenser combination rules */}
                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between">
                      <Text as="h3" variant="headingSm">
                        Per-Condenser Combination Rules
                      </Text>
                      <Button
                        onClick={() =>
                          setComboRules((prev) => [
                            ...prev,
                            {
                              name: `Rule ${prev.length + 1}`,
                              enabled: true,
                              outdoor_source_sku: "",
                              allowed_indoor_skus: [],
                              min_indoor_per_outdoor: "2",
                              max_indoor_per_outdoor: "6",
                              percent_off_hvac_products: String(hvacPercent),
                              amount_off_outdoor_per_bundle: String(hvacAmountOff),
                              stack_mode: "stackable",
                            },
                          ])
                        }
                      >
                        + Add Combination Rule
                      </Button>
                    </InlineStack>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Customize which indoor heads are allowed per outdoor condenser. Each rule defines
                      a specific condenser and its permitted indoor units with custom discount settings.
                    </Text>

                    {comboRules.map((rule, idx) => {
                      const compatibleIndoorMappings = getCompatibleIndoorMappings(
                        rule.outdoor_source_sku,
                      );
                      const compatibleIndoorSkus = compatibleIndoorMappings.map((m) => m.sourceSku);
                      const selectedIndoorCount = rule.allowed_indoor_skus.filter((sku) =>
                        compatibleIndoorSkus.includes(sku),
                      ).length;

                      return (
                      <Card key={`combo-${idx}`}>
                        <BlockStack gap="300">
                          <InlineStack align="space-between" blockAlign="center">
                            <InlineStack gap="200" blockAlign="center">
                              <Checkbox
                                label=""
                                checked={rule.enabled}
                                onChange={(v) =>
                                  setComboRules((p) =>
                                    p.map((r, i) => (i === idx ? { ...r, enabled: v } : r)),
                                  )
                                }
                              />
                              <Text as="h4" variant="headingSm">
                                {rule.name || `Rule ${idx + 1}`}
                              </Text>
                              {!rule.enabled && <Badge tone="attention">disabled</Badge>}
                            </InlineStack>
                            <Button
                              variant="plain"
                              tone="critical"
                              onClick={() =>
                                setComboRules((p) => p.filter((_, i) => i !== idx))
                              }
                            >
                              Remove
                            </Button>
                          </InlineStack>

                          <TextField
                            label="Rule Name"
                            value={rule.name}
                            onChange={(v) =>
                              setComboRules((p) =>
                                p.map((r, i) => (i === idx ? { ...r, name: v } : r)),
                              )
                            }
                            autoComplete="off"
                          />

                          <Select
                            label="Outdoor Condenser (SKU)"
                            options={[
                              { label: "— Select condenser —", value: "" },
                              ...outdoorMappingEntries.map((m) => ({
                                label: [m.sourceSku, m.sourceBrand, m.sourceRefrigerant].filter(Boolean).join(" — "),
                                value: m.sourceSku,
                              })),
                            ]}
                            value={rule.outdoor_source_sku}
                            onChange={(v) =>
                              setComboRules((p) =>
                                p.map((r, i) => {
                                  if (i !== idx) return r;
                                  const allowedPool = getCompatibleIndoorMappings(v).map(
                                    (m) => m.sourceSku,
                                  );
                                  return {
                                    ...r,
                                    outdoor_source_sku: v,
                                    allowed_indoor_skus: r.allowed_indoor_skus.filter((sku) =>
                                      allowedPool.includes(sku),
                                    ),
                                  };
                                }),
                              )
                            }
                          />

                          <Text as="p" variant="bodyMd">
                            Allowed Indoor Heads ({selectedIndoorCount} selected)
                          </Text>
                          <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid #ddd", borderRadius: 4, padding: 8 }}>
                            <BlockStack gap="100">
                              <InlineStack gap="200">
                                <Button
                                  variant="plain"
                                  onClick={() =>
                                    setComboRules((p) =>
                                      p.map((r, i) =>
                                        i === idx
                                          ? {
                                              ...r,
                                              allowed_indoor_skus: compatibleIndoorMappings.map(
                                                (m) => m.sourceSku,
                                              ),
                                            }
                                          : r,
                                      ),
                                    )
                                  }
                                >
                                  Select All
                                </Button>
                                <Button
                                  variant="plain"
                                  onClick={() =>
                                    setComboRules((p) =>
                                      p.map((r, i) =>
                                        i === idx ? { ...r, allowed_indoor_skus: [] } : r,
                                      ),
                                    )
                                  }
                                >
                                  Clear All
                                </Button>
                              </InlineStack>
                              {!rule.outdoor_source_sku && (
                                <Text as="p" variant="bodySm" tone="subdued">
                                  Select an outdoor condenser first.
                                </Text>
                              )}
                              {rule.outdoor_source_sku && compatibleIndoorMappings.length === 0 && (
                                <Text as="p" variant="bodySm" tone="subdued">
                                  No indoor mappings match this condenser brand + refrigerant.
                                </Text>
                              )}
                              {compatibleIndoorMappings.map((m) => (
                                <Checkbox
                                  key={m.sourceSku}
                                  label={[m.sourceSku, m.sourceBrand, m.sourceType, m.sourceSeries, m.sourceRefrigerant].filter(Boolean).join(" — ")}
                                  checked={rule.allowed_indoor_skus.includes(m.sourceSku)}
                                  onChange={(checked) =>
                                    setComboRules((p) =>
                                      p.map((r, i) => {
                                        if (i !== idx) return r;
                                        const skus = checked
                                          ? [...r.allowed_indoor_skus, m.sourceSku]
                                          : r.allowed_indoor_skus.filter((s) => s !== m.sourceSku);
                                        return { ...r, allowed_indoor_skus: skus };
                                      }),
                                    )
                                  }
                                />
                              ))}
                            </BlockStack>
                          </div>

                          <FormLayout>
                            <FormLayout.Group>
                              <TextField
                                label="Min indoor"
                                type="number"
                                value={rule.min_indoor_per_outdoor}
                                onChange={(v) =>
                                  setComboRules((p) =>
                                    p.map((r, i) =>
                                      i === idx ? { ...r, min_indoor_per_outdoor: v } : r,
                                    ),
                                  )
                                }
                                autoComplete="off"
                              />
                              <TextField
                                label="Max indoor"
                                type="number"
                                value={rule.max_indoor_per_outdoor}
                                onChange={(v) =>
                                  setComboRules((p) =>
                                    p.map((r, i) =>
                                      i === idx ? { ...r, max_indoor_per_outdoor: v } : r,
                                    ),
                                  )
                                }
                                autoComplete="off"
                              />
                            </FormLayout.Group>
                            <FormLayout.Group>
                              <TextField
                                label="% off"
                                type="number"
                                value={rule.percent_off_hvac_products}
                                onChange={(v) =>
                                  setComboRules((p) =>
                                    p.map((r, i) =>
                                      i === idx
                                        ? { ...r, percent_off_hvac_products: v }
                                        : r,
                                    ),
                                  )
                                }
                                autoComplete="off"
                              />
                              <TextField
                                label="$ off per outdoor"
                                type="number"
                                value={rule.amount_off_outdoor_per_bundle}
                                onChange={(v) =>
                                  setComboRules((p) =>
                                    p.map((r, i) =>
                                      i === idx
                                        ? { ...r, amount_off_outdoor_per_bundle: v }
                                        : r,
                                    ),
                                  )
                                }
                                autoComplete="off"
                              />
                            </FormLayout.Group>
                            <Select
                              label="Stack Mode"
                              options={[
                                { label: "Stackable", value: "stackable" },
                                { label: "Exclusive best rule only", value: "exclusive_best" },
                              ]}
                              value={rule.stack_mode}
                              onChange={(v) =>
                                setComboRules((p) =>
                                  p.map((r, i) =>
                                    i === idx
                                      ? { ...r, stack_mode: v }
                                      : r,
                                  ),
                                )
                              }
                            />
                          </FormLayout>
                        </BlockStack>
                      </Card>
                      );
                    })}

                    {comboRules.length === 0 && (
                      <Text as="p" variant="bodyMd" tone="subdued">
                        No combination rules yet. All mapped indoor/outdoor products will use the
                        global defaults above.
                      </Text>
                    )}
                  </BlockStack>
                </Card>
              </BlockStack>
            </Layout.Section>
          )}

          {/* ── Spend Rules (X/Y/Z) ── */}
          {section === "spend" && (
            <Layout.Section>
              <BlockStack gap="400">
                <Card>
                  <BlockStack gap="400">
                    <Text as="h3" variant="headingSm">
                      Collection Spend Rule (X/Y/Z)
                    </Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Customers earn a stepped discount by spending on products from this collection.
                      Each spend step grants a fixed dollar amount off. Product IDs are fetched on save.
                    </Text>
                    <Select
                      label="Collection"
                      options={collectionOptions}
                      value={spendCollection}
                      onChange={setSpendCollection}
                    />
                    <FormLayout>
                      <FormLayout.Group>
                        <TextField
                          label="$ off per spend step"
                          type="number"
                          value={spendAmtPerStep}
                          onChange={setSpendAmtPerStep}
                          helpText="Fixed dollar amount off per step (e.g. $100 off per $1500 spent)"
                          autoComplete="off"
                        />
                        <TextField
                          label="Spend step amount ($)"
                          type="number"
                          value={spendStepAmount}
                          onChange={setSpendStepAmount}
                          helpText="e.g. 1500 = gain 1 step per $1,500 spent on collection products"
                          autoComplete="off"
                        />
                      </FormLayout.Group>
                      <FormLayout.Group>
                        <TextField
                          label="Min collection item qty to activate"
                          type="number"
                          value={spendMinQty}
                          onChange={setSpendMinQty}
                          autoComplete="off"
                        />
                        <TextField
                          label="Max discounted units per order (0 = unlimited)"
                          type="number"
                          value={spendMaxUnits}
                          onChange={setSpendMaxUnits}
                          autoComplete="off"
                        />
                      </FormLayout.Group>
                    </FormLayout>
                  </BlockStack>
                </Card>

                <Card>
                  <BlockStack gap="400">
                    <Text as="h3" variant="headingSm">
                      Activation Conditions
                    </Text>
                    <Select
                      label="When is the spend rule active?"
                      options={[
                        { label: "Always active", value: "always" },
                        { label: "Only if no discount code entered", value: "no_other_discounts" },
                        {
                          label: "Only if selected discount types (X/Y/Z) are active",
                          value: "requires_any_xyz_active",
                        },
                        {
                          label: "Only if X/Y/Z discount types match specific states",
                          value: "requires_xyz_state",
                        },
                      ]}
                      value={spendMode}
                      onChange={(v) => setSpendMode(v as SpendActivationMode)}
                    />

                    {showXyzOptions && (
                      <>
                        <Text as="p" variant="bodyMd">
                          Required discount types (X = bulk, Y = VIP, Z = first order):
                        </Text>
                        <InlineStack gap="400">
                          <Checkbox label="X — Bulk discount active" checked={spendReqBulk} onChange={setSpendReqBulk} />
                          <Checkbox label="Y — VIP discount active" checked={spendReqVip} onChange={setSpendReqVip} />
                          <Checkbox label="Z — First-order discount active" checked={spendReqFirst} onChange={setSpendReqFirst} />
                        </InlineStack>
                        <Select
                          label="Required types operator"
                          options={[
                            { label: "OR — any one must be active", value: "or" },
                            { label: "AND — all must be active", value: "and" },
                          ]}
                          value={spendXyzOp}
                          onChange={(v) => setSpendXyzOp(v as "and" | "or")}
                        />
                      </>
                    )}

                    {spendMode === "requires_xyz_state" && (
                      <FormLayout>
                        <FormLayout.Group>
                          <Select
                            label="Bulk (X) state"
                            options={stateOptions}
                            value={spendBulkState}
                            onChange={(v) => setSpendBulkState(v as RuleConditionState)}
                          />
                          <Select
                            label="VIP (Y) state"
                            options={stateOptions}
                            value={spendVipState}
                            onChange={(v) => setSpendVipState(v as RuleConditionState)}
                          />
                          <Select
                            label="First-order (Z) state"
                            options={stateOptions}
                            value={spendFirstState}
                            onChange={(v) => setSpendFirstState(v as RuleConditionState)}
                          />
                        </FormLayout.Group>
                      </FormLayout>
                    )}
                  </BlockStack>
                </Card>
              </BlockStack>
            </Layout.Section>
          )}

          {/* ── Status ── */}
          {section === "status" && (
            <Layout.Section>
              <BlockStack gap="400">
                {/* Active Discount Check */}
                <Card>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">
                      Active Discounts (Shopify Admin)
                    </Text>
                    {diagnostics.activeAppDiscounts.length === 0 ? (
                      <Banner tone="critical" title="No active app discounts found!">
                        <Text as="p" variant="bodyMd">
                          The checkout function will NOT run unless there is an active automatic
                          discount using this app. Go to Shopify Admin &gt; Discounts and create
                          one using &quot;Smart Discount Engine 2&quot;, or re-activate an existing one.
                        </Text>
                      </Banner>
                    ) : (
                      <List type="bullet">
                        {diagnostics.activeAppDiscounts.map((d: any, i: number) => (
                          <List.Item key={i}>
                            <Badge tone="success">ACTIVE</Badge>{" "}
                            {d.title}
                          </List.Item>
                        ))}
                      </List>
                    )}
                  </BlockStack>
                </Card>

                {/* Metafield Storage */}
                <Card>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">
                      Metafield Config Storage
                    </Text>
                    <List type="bullet">
                      <List.Item>
                        Metafield exists:{" "}
                        <Badge tone={diagnostics.hasMetafield ? "success" : "critical"}>
                          {diagnostics.hasMetafield ? "Yes" : "No"}
                        </Badge>
                      </List.Item>
                      <List.Item>Config size: {diagnostics.configByteSize.toLocaleString()} bytes</List.Item>
                      <List.Item>Item discounts: stored as product metafields (not in config)</List.Item>
                    </List>
                    {!diagnostics.hasMetafield && (
                      <Banner tone="warning" title="Config metafield is empty">
                        <Text as="p" variant="bodyMd">
                          Click &quot;Save Config&quot; to write the config to shop metafields. The checkout
                          function reads these metafields at runtime.
                        </Text>
                      </Banner>
                    )}
                  </BlockStack>
                </Card>

                {/* What the Rust Function Sees */}
                <Card>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">
                      Config Values (what the checkout function uses)
                    </Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      These are the values from the saved metafield. If they look wrong, click Save Config
                      to re-write them. Then run &quot;shopify app deploy&quot; to update the Rust function.
                    </Text>
                    <List type="bullet">
                      <List.Item>
                        First Order:{" "}
                        <Badge tone={diagnostics.keyValues.first_order_enabled ? "success" : "attention"}>
                          {diagnostics.keyValues.first_order_enabled ? "ON" : "OFF"}
                        </Badge>
                        {" — "}
                        {diagnostics.keyValues.first_order_percent}% (requires logged-in customer with 0 orders)
                      </List.Item>
                      <List.Item>
                        Bulk:{" "}
                        <Badge tone={diagnostics.keyValues.bulk_enabled ? "success" : "attention"}>
                          {diagnostics.keyValues.bulk_enabled ? "ON" : "OFF"}
                        </Badge>
                        {" — "}
                        Tiers: ${diagnostics.keyValues.bulk5_min}={diagnostics.keyValues.bulk5_percent}%,
                        ${diagnostics.keyValues.bulk10_min}={diagnostics.keyValues.bulk10_percent}%,
                        ${diagnostics.keyValues.bulk13_min}={diagnostics.keyValues.bulk13_percent}%,
                        ${diagnostics.keyValues.bulk15_min}={diagnostics.keyValues.bulk15_percent}%
                      </List.Item>
                      <List.Item>
                        VIP:{" "}
                        <Badge tone={diagnostics.keyValues.vip_enabled ? "success" : "attention"}>
                          {diagnostics.keyValues.vip_enabled ? "ON" : "OFF"}
                        </Badge>
                        {" — "}
                        (requires logged-in customer with VIP3–VIP25 tags)
                      </List.Item>
                      <List.Item>
                        Item Collection:{" "}
                        <Badge tone={diagnostics.keyValues.item_collection_enabled ? "success" : "attention"}>
                          {diagnostics.keyValues.item_collection_enabled ? "ON" : "OFF"}
                        </Badge>
                        {" — "}
                        {diagnostics.keyValues.item_rule_count} rules (product metafield-based)
                      </List.Item>
                      <List.Item>
                        HVAC:{" "}
                        <Badge tone={diagnostics.keyValues.hvac_enabled ? "success" : "attention"}>
                          {diagnostics.keyValues.hvac_enabled ? "ON" : "OFF"}
                        </Badge>
                        {" — "}
                        {diagnostics.keyValues.hvac_indoor_ids} indoor / {diagnostics.keyValues.hvac_outdoor_ids} outdoor /
                        {" "}{diagnostics.keyValues.hvac_combo_rules} combo rules
                      </List.Item>
                    </List>
                  </BlockStack>
                </Card>

                {/* Deployment Instructions */}
                <Card>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">
                      Deployment Checklist
                    </Text>
                    <Banner tone="info" title="Important: Two deployments are needed">
                      <List type="number">
                        <List.Item>
                          <strong>Render (auto)</strong>: Push to GitHub — the admin UI auto-deploys to Render.
                        </List.Item>
                        <List.Item>
                          <strong>Shopify Function (manual)</strong>: Run <code>shopify app deploy</code> from
                          your terminal to compile and upload the Rust WASM checkout function to Shopify.
                          Without this, the function on Shopify still uses the old code.
                        </List.Item>
                        <List.Item>
                          <strong>Save Config</strong>: After deploying, click Save Config here to write
                          the latest settings to shop metafields.
                        </List.Item>
                        <List.Item>
                          <strong>Active Discount</strong>: Ensure there is an active automatic discount
                          in Shopify Admin &gt; Discounts using &quot;Smart Discount Engine 2&quot;.
                        </List.Item>
                      </List>
                    </Banner>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      The bulk discount currently compares cart subtotal ($) against the tier thresholds.
                      For bulk to trigger, the customer needs a cart subtotal of at least ${diagnostics.keyValues.bulk5_min}.
                      First-order and VIP require logged-in customers.
                    </Text>
                  </BlockStack>
                </Card>
              </BlockStack>
            </Layout.Section>
          )}

          {/* Save */}
          <Layout.Section>
            <InlineStack align="end">
              <Button variant="primary" submit size="large">
                Save Config
              </Button>
            </InlineStack>
          </Layout.Section>
        </Layout>
      </form>
    </Page>
  );
}
