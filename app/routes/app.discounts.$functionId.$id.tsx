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
  product_ids: string[];
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
  stack_mode: "independent" | "shared";
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

// 45 KB per chunk so that JSON.stringify(fragment) stays well under Shopify's 65 535 B limit
const CHUNK_SIZE = 45_000;
const MAX_PARTS = 6;

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
      if (node?.id) ids.push(String(node.id));
    }
    if (!block.pageInfo?.hasNextPage) break;
    after = block.pageInfo.endCursor ?? null;
  }
  return ids;
}

function decodeJsonString(raw: string): string {
  try {
    const decoded = JSON.parse(raw);
    return typeof decoded === "string" ? decoded : raw;
  } catch {
    return raw;
  }
}

function parseShopConfig(primary: string | null, parts: Array<string | null>): RuntimeConfig {
  let jsonRaw: string | null = null;

  if (primary) {
    const decoded = decodeJsonString(primary);
    try {
      const manifest = JSON.parse(decoded) as any;
      if (manifest?.chunked && Number(manifest.parts) > 0) {
        const count = Number(manifest.parts);
        let joined = "";
        let ok = true;
        for (let i = 0; i < count; i++) {
          const part = parts[i];
          if (!part) { ok = false; break; }
          joined += decodeJsonString(part);
        }
        if (ok) jsonRaw = joined;
      } else {
        jsonRaw = decoded;
      }
    } catch {
      jsonRaw = decoded;
    }
  }

  if (!jsonRaw) {
    const fallback = parts.filter(Boolean).map((p) => decodeJsonString(p!)).join("");
    jsonRaw = fallback || null;
  }

  if (!jsonRaw) return DEFAULT_CONFIG;

  try {
    const parsed = JSON.parse(jsonRaw) as any;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      toggles: { ...DEFAULT_CONFIG.toggles, ...(parsed.toggles ?? {}) },
      item_collection_rules: Array.isArray(parsed.item_collection_rules)
        ? parsed.item_collection_rules
        : [],
      hvac_rule: { ...DEFAULT_HVAC, ...(parsed.hvac_rule ?? {}) },
      collection_spend_rule: {
        ...DEFAULT_SPEND,
        ...(parsed.collection_spend_rule ?? {}),
        // Support legacy field name migration
        amount_off_per_step:
          parsed.collection_spend_rule?.amount_off_per_step ??
          parsed.collection_spend_rule?.percent_off_per_step ??
          DEFAULT_SPEND.amount_off_per_step,
        activation: {
          ...DEFAULT_ACTIVATION,
          ...(parsed.collection_spend_rule?.activation ?? {}),
        },
      },
      return_blocked_codes: Array.isArray(parsed.return_blocked_codes)
        ? parsed.return_blocked_codes
        : DEFAULT_CONFIG.return_blocked_codes,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function chunkConfig(config: RuntimeConfig): { manifest: string; parts: string[] } {
  const fullJson = JSON.stringify(config);
  if (Buffer.byteLength(fullJson, "utf8") <= CHUNK_SIZE) {
    return { manifest: fullJson, parts: [] };
  }
  const rawParts: string[] = [];
  let offset = 0;
  while (offset < fullJson.length) {
    let end = offset + CHUNK_SIZE;
    while (
      end < fullJson.length &&
      Buffer.byteLength(fullJson.slice(offset, end), "utf8") > CHUNK_SIZE
    ) {
      end -= 100;
    }
    rawParts.push(fullJson.slice(offset, end));
    offset = end;
  }
  if (rawParts.length > MAX_PARTS) {
    throw new Error(
      `Config needs ${rawParts.length} chunks, max is ${MAX_PARTS}. Reduce collection sizes.`,
    );
  }
  return { manifest: JSON.stringify({ chunked: true, parts: rawParts.length }), parts: rawParts };
}

// ── Loader ─────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const [collections, configRes, hvacMappings] = await Promise.all([
    fetchCollections(admin),
    admin.graphql(`
      #graphql
      query ShopRuntimeConfig {
        shop {
          runtimeConfig: metafield(namespace: "smart_discount_engine", key: "config") { value }
          part1: metafield(namespace: "smart_discount_engine", key: "config-part-1") { value }
          part2: metafield(namespace: "smart_discount_engine", key: "config-part-2") { value }
          part3: metafield(namespace: "smart_discount_engine", key: "config-part-3") { value }
          part4: metafield(namespace: "smart_discount_engine", key: "config-part-4") { value }
          part5: metafield(namespace: "smart_discount_engine", key: "config-part-5") { value }
          part6: metafield(namespace: "smart_discount_engine", key: "config-part-6") { value }
        }
      }
    `),
    prisma.hvacSkuMapping.findMany({
      where: { shop, matchStatus: { in: ["auto_exact", "manual"] } },
      orderBy: [{ sourceType: "asc" }, { sourceBrand: "asc" }, { sourceSku: "asc" }],
    }),
  ]);

  const configData = await configRes.json();
  const shopData = configData?.data?.shop;

  const config = parseShopConfig(shopData?.runtimeConfig?.value ?? null, [
    shopData?.part1?.value ?? null,
    shopData?.part2?.value ?? null,
    shopData?.part3?.value ?? null,
    shopData?.part4?.value ?? null,
    shopData?.part5?.value ?? null,
    shopData?.part6?.value ?? null,
  ]);

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
      mappedProductId: m.mappedProductId,
      mappedProductTitle: m.mappedProductTitle,
      matchStatus: m.matchStatus,
    }));

  return json({ config, collections, indoorMappings, outdoorMappings });
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

  // Fetch product IDs for item collection rules
  const item_collection_rules: ItemCollectionRule[] = await Promise.all(
    (parsed.item_collection_rules ?? []).map(async (rule) => {
      const product_ids = await fetchAllProductIds(admin, rule.collection_id);
      productCounts.push({ label: `Item rule (${rule.percent}%)`, count: product_ids.length });
      return { collection_id: rule.collection_id, percent: rule.percent, product_ids };
    }),
  );

  // Pull HVAC product IDs from the mapping database (not collections)
  const hvacBase = parsed.hvac_rule ?? DEFAULT_HVAC;
  const allHvacMappings = await prisma.hvacSkuMapping.findMany({
    where: { shop, matchStatus: { in: ["auto_exact", "manual"] }, mappedProductId: { not: null } },
  });

  const indoorIds = [
    ...new Set(
      allHvacMappings
        .filter((m) => m.sourceType === "indoor" && m.mappedProductId)
        .map((m) => m.mappedProductId!),
    ),
  ];
  const outdoorIds = [
    ...new Set(
      allHvacMappings
        .filter((m) => m.sourceType === "outdoor" && m.mappedProductId)
        .map((m) => m.mappedProductId!),
    ),
  ];

  productCounts.push({ label: "HVAC indoor (from mapping)", count: indoorIds.length });
  productCounts.push({ label: "HVAC outdoor (from mapping)", count: outdoorIds.length });

  // Build a SKU → product ID lookup for combination rules
  const skuToProductId = new Map<string, string>();
  for (const m of allHvacMappings) {
    if (m.mappedProductId) {
      skuToProductId.set(m.sourceSku.toUpperCase(), m.mappedProductId);
    }
  }

  // Resolve combination rules: convert SKUs to product IDs
  const combination_rules = (hvacBase.combination_rules ?? []).map((rule) => {
    const outdoorPid = rule.outdoor_source_sku
      ? skuToProductId.get(rule.outdoor_source_sku.toUpperCase())
      : undefined;
    return {
      ...rule,
      outdoor_product_ids: outdoorPid ? [outdoorPid] : [] as string[],
      indoor_product_ids: (rule.allowed_indoor_skus ?? [])
        .map((sku: string) => skuToProductId.get(sku.toUpperCase()))
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

  let manifest: string;
  let parts: string[];
  try {
    const chunked = chunkConfig(fullConfig);
    manifest = chunked.manifest;
    parts = chunked.parts;
  } catch (err) {
    return json<ActionResult>({
      ok: false,
      errors: [err instanceof Error ? err.message : "Failed to serialize config."],
      productCounts,
    });
  }

  // Get shop GID for shop-level metafields (what the Rust function reads)
  const shopRes = await admin.graphql(`
    #graphql
    query GetShopId {
      shop { id }
    }
  `);
  const shopData = await shopRes.json();
  const shopId = shopData?.data?.shop?.id as string | undefined;

  if (!shopId) {
    return json<ActionResult>({ ok: false, errors: ["Could not resolve shop ID."], productCounts });
  }

  // Parts are stored as JSON-encoded strings (JSON.stringify wraps the fragment in quotes +
  // escapes inner quotes). This makes each metafield value valid JSON, which Shopify requires
  // for type "json". The Rust function's decode_json_string() unwraps them transparently.
  const metafields: any[] = [
    {
      ownerId: shopId,
      namespace: "smart_discount_engine",
      key: "config",
      type: "json",
      value: manifest,
    },
    ...parts.map((part, i) => ({
      ownerId: shopId,
      namespace: "smart_discount_engine",
      key: `config-part-${i + 1}`,
      type: "json",
      value: JSON.stringify(part), // fragment wrapped as a JSON string → valid JSON
    })),
  ];

  const saveRes = await admin.graphql(
    `
    #graphql
    mutation SaveRuntimeConfig($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        userErrors { field message }
      }
    }`,
    { variables: { metafields } },
  );

  const saveData = await saveRes.json();
  const errors: string[] = (saveData?.data?.metafieldsSet?.userErrors ?? []).map(
    (e: any) => String(e?.message ?? "Unknown error"),
  );

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
  stack_mode: "independent" | "shared";
};

export default function DiscountConfigRoute() {
  const { config, collections, indoorMappings, outdoorMappings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

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
      name: r.name ?? "",
      enabled: r.enabled ?? true,
      outdoor_source_sku: r.outdoor_source_sku ?? "",
      allowed_indoor_skus: r.allowed_indoor_skus ?? [],
      min_indoor_per_outdoor: String(r.min_indoor_per_outdoor ?? 2),
      max_indoor_per_outdoor: String(r.max_indoor_per_outdoor ?? 6),
      percent_off_hvac_products: String(r.percent_off_hvac_products ?? 0),
      amount_off_outdoor_per_bundle: String(r.amount_off_outdoor_per_bundle ?? 0),
      stack_mode: r.stack_mode ?? "independent",
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

  const collectionOptions = [
    { label: "— Select collection —", value: "" },
    ...collections.map((c: CollectionOption) => ({ label: c.title, value: c.id })),
  ];

  const totalItemProducts = config.item_collection_rules.reduce(
    (s, r) => s + (r.product_ids?.length ?? 0),
    0,
  );

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
        .map((r) => ({ collection_id: r.collection_id, percent: Number(r.percent), product_ids: [] })),
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
          outdoor_product_ids: [],
          indoor_product_ids: [],
          min_indoor_per_outdoor: Number(r.min_indoor_per_outdoor) || 2,
          max_indoor_per_outdoor: Number(r.max_indoor_per_outdoor) || 6,
          percent_off_hvac_products: Number(r.percent_off_hvac_products) || 0,
          amount_off_outdoor_per_bundle: Number(r.amount_off_outdoor_per_bundle) || 0,
          stack_mode: r.stack_mode,
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
                    Products in the selected collection get the specified discount %. Product IDs are
                    fetched on save — handles 2500+ products via chunked shop metafields.
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
                              stack_mode: "independent",
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

                    {comboRules.map((rule, idx) => (
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
                              ...(outdoorMappings as HvacMappingEntry[]).map((m) => ({
                                label: `${m.sourceSku} — ${m.sourceBrand ?? ""} ${m.mappedProductTitle ?? ""}`,
                                value: m.sourceSku,
                              })),
                            ]}
                            value={rule.outdoor_source_sku}
                            onChange={(v) =>
                              setComboRules((p) =>
                                p.map((r, i) =>
                                  i === idx ? { ...r, outdoor_source_sku: v } : r,
                                ),
                              )
                            }
                          />

                          <Text as="p" variant="bodyMd">
                            Allowed Indoor Heads ({rule.allowed_indoor_skus.length} selected)
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
                                              allowed_indoor_skus: (indoorMappings as HvacMappingEntry[]).map(
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
                              {(indoorMappings as HvacMappingEntry[]).map((m) => (
                                <Checkbox
                                  key={m.sourceSku}
                                  label={`${m.sourceSku} — ${m.sourceBrand ?? ""} ${m.sourceSystem ?? ""} ${m.sourceBtu ? m.sourceBtu + " BTU" : ""}`}
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
                                { label: "Independent (each condenser is separate)", value: "independent" },
                                { label: "Shared (all condensers share indoor pool)", value: "shared" },
                              ]}
                              value={rule.stack_mode}
                              onChange={(v) =>
                                setComboRules((p) =>
                                  p.map((r, i) =>
                                    i === idx
                                      ? { ...r, stack_mode: v as "independent" | "shared" }
                                      : r,
                                  ),
                                )
                              }
                            />
                          </FormLayout>
                        </BlockStack>
                      </Card>
                    ))}

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
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Current Saved Config
                  </Text>
                  <List type="bullet">
                    <List.Item>
                      Item rules: {config.item_collection_rules.length} —{" "}
                      <Badge tone={totalItemProducts > 0 ? "success" : "attention"}>
                        {`${totalItemProducts} product IDs`}
                      </Badge>
                    </List.Item>
                    <List.Item>
                      HVAC:{" "}
                      <Badge tone={config.toggles.hvac_enabled ? "success" : "attention"}>
                        {config.toggles.hvac_enabled ? "Enabled" : "Disabled"}
                      </Badge>
                      {" — "}
                      {config.hvac_rule.indoor_product_ids.length} indoor /{" "}
                      {config.hvac_rule.outdoor_product_ids.length} outdoor /{" "}
                      {config.hvac_rule.combination_rules?.length ?? 0} combination rules
                    </List.Item>
                    <List.Item>
                      HVAC Mapping:{" "}
                      <Badge tone="info">{`${(indoorMappings as HvacMappingEntry[]).length} indoor mapped`}</Badge>{" "}
                      <Badge tone="info">{`${(outdoorMappings as HvacMappingEntry[]).length} outdoor mapped`}</Badge>
                    </List.Item>
                    <List.Item>
                      Collection spend:{" "}
                      <Badge tone={config.toggles.collection_spend_enabled ? "success" : "attention"}>
                        {config.toggles.collection_spend_enabled ? "Enabled" : "Disabled"}
                      </Badge>
                      {" — $"}
                      {config.collection_spend_rule.amount_off_per_step} off per ${config.collection_spend_rule.spend_step_amount} spent
                      {" — "}
                      {config.collection_spend_rule.product_ids.length} product IDs
                    </List.Item>
                    <List.Item>
                      Block if discount code entered:{" "}
                      {config.block_if_any_entered_discount_code ? "Yes" : "No"}
                    </List.Item>
                    <List.Item>
                      Return conflict codes:{" "}
                      {config.return_conflict_enabled
                        ? config.return_blocked_codes.join(", ")
                        : "disabled"}
                    </List.Item>
                    <List.Item>
                      Storage: shop metafields (smart_discount_engine/config + parts 1–6)
                    </List.Item>
                  </List>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Config is chunked at 45 KB per part. Max 6 parts = 270 KB capacity. The
                    checkout function reads these at runtime with no Shopify query complexity cost.
                  </Text>
                </BlockStack>
              </Card>
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
