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

// ── Types ─────────────────────────────────────────────────────────────────────

type CollectionOption = { id: string; title: string };

type ItemCollectionRule = {
  collection_id: string;
  percent: number;
  product_ids: string[];
};

type HvacCombinationRule = {
  name: string;
  enabled: boolean;
  min_indoor_per_outdoor: number;
  max_indoor_per_outdoor: number;
  indoor_product_ids: string[];
  outdoor_product_ids: string[];
  percent_off_hvac_products: number;
  amount_off_outdoor_per_bundle: number;
  stack_mode: string;
};

type HvacRule = {
  enabled: boolean;
  // stored for admin re-load; ignored by Rust function
  indoor_collection_id: string;
  outdoor_collection_id: string;
  min_indoor_per_outdoor: number;
  max_indoor_per_outdoor: number;
  percent_off_hvac_products: number;
  amount_off_outdoor_per_bundle: number;
  indoor_product_ids: string[];
  outdoor_product_ids: string[];
  combination_rules: HvacCombinationRule[];
};

type CollectionSpendRule = {
  enabled: boolean;
  collection_id: string;
  percent_off_per_step: number;
  min_collection_qty: number;
  spend_step_amount: number;
  product_ids: string[];
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
};

type ActionResult = {
  ok: boolean;
  errors: string[];
  productCounts: Array<{ label: string; count: number }>;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 50_000;
const MAX_PARTS = 6;

const DEFAULT_HVAC: HvacRule = {
  enabled: false,
  indoor_collection_id: "",
  outdoor_collection_id: "",
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
  percent_off_per_step: 2,
  min_collection_qty: 1,
  spend_step_amount: 100,
  product_ids: [],
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
};

// ── Server helpers ────────────────────────────────────────────────────────────

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
      collection_spend_rule: { ...DEFAULT_SPEND, ...(parsed.collection_spend_rule ?? {}) },
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
  const parts: string[] = [];
  let offset = 0;
  while (offset < fullJson.length) {
    let end = offset + CHUNK_SIZE;
    while (
      end < fullJson.length &&
      Buffer.byteLength(fullJson.slice(offset, end), "utf8") > CHUNK_SIZE
    ) {
      end -= 100;
    }
    parts.push(fullJson.slice(offset, end));
    offset = end;
  }
  if (parts.length > MAX_PARTS) {
    throw new Error(`Config needs ${parts.length} chunks, max is ${MAX_PARTS}. Reduce collection sizes.`);
  }
  return { manifest: JSON.stringify({ chunked: true, parts: parts.length }), parts };
}

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const [collections, configRes] = await Promise.all([
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
  ]);

  const configData = await configRes.json();
  const shop = configData?.data?.shop;

  const config = parseShopConfig(shop?.runtimeConfig?.value ?? null, [
    shop?.part1?.value ?? null,
    shop?.part2?.value ?? null,
    shop?.part3?.value ?? null,
    shop?.part4?.value ?? null,
    shop?.part5?.value ?? null,
    shop?.part6?.value ?? null,
  ]);

  return json({ config, collections });
};

// ── Action ────────────────────────────────────────────────────────────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
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

  // Fetch product IDs for HVAC indoor/outdoor collections
  const hvacBase = parsed.hvac_rule ?? DEFAULT_HVAC;
  const [indoorIds, outdoorIds] = await Promise.all([
    fetchAllProductIds(admin, hvacBase.indoor_collection_id ?? ""),
    fetchAllProductIds(admin, hvacBase.outdoor_collection_id ?? ""),
  ]);
  if (indoorIds.length > 0) productCounts.push({ label: "HVAC indoor", count: indoorIds.length });
  if (outdoorIds.length > 0) productCounts.push({ label: "HVAC outdoor", count: outdoorIds.length });

  const hvac_rule: HvacRule = {
    ...hvacBase,
    indoor_product_ids: indoorIds,
    outdoor_product_ids: outdoorIds,
    combination_rules: hvacBase.combination_rules ?? [],
  };

  // Fetch product IDs for collection spend rule
  const spendBase = parsed.collection_spend_rule ?? DEFAULT_SPEND;
  const spendIds = await fetchAllProductIds(admin, spendBase.collection_id ?? "");
  if (spendIds.length > 0) productCounts.push({ label: "Collection spend", count: spendIds.length });

  const collection_spend_rule: CollectionSpendRule = { ...spendBase, product_ids: spendIds };

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

  const metafields: any[] = [
    { ownerId: shopId, namespace: "smart_discount_engine", key: "config", type: "json", value: manifest },
    ...parts.map((part, i) => ({
      ownerId: shopId,
      namespace: "smart_discount_engine",
      key: `config-part-${i + 1}`,
      type: "json",
      value: part,
    })),
  ];

  const saveRes = await admin.graphql(`
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

// ── Component ─────────────────────────────────────────────────────────────────

type Section = "order" | "item" | "hvac" | "spend" | "status";
type RuleState = { collection_id: string; percent: string };

export default function DiscountConfigRoute() {
  const { config, collections } = useLoaderData<typeof loader>();
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

  // Item rules
  const [rules, setRules] = useState<RuleState[]>(
    config.item_collection_rules.map((r) => ({
      collection_id: r.collection_id,
      percent: String(r.percent),
    })),
  );

  // HVAC rules
  const [hvacEnabled, setHvacEnabled] = useState(config.hvac_rule.enabled);
  const [hvacIndoor, setHvacIndoor] = useState(config.hvac_rule.indoor_collection_id ?? "");
  const [hvacOutdoor, setHvacOutdoor] = useState(config.hvac_rule.outdoor_collection_id ?? "");
  const [hvacMinIndoor, setHvacMinIndoor] = useState(String(config.hvac_rule.min_indoor_per_outdoor));
  const [hvacMaxIndoor, setHvacMaxIndoor] = useState(String(config.hvac_rule.max_indoor_per_outdoor));
  const [hvacPercent, setHvacPercent] = useState(String(config.hvac_rule.percent_off_hvac_products));
  const [hvacAmountOff, setHvacAmountOff] = useState(String(config.hvac_rule.amount_off_outdoor_per_bundle));

  // Collection spend rule
  const [spendCollection, setSpendCollection] = useState(config.collection_spend_rule.collection_id);
  const [spendPctPerStep, setSpendPctPerStep] = useState(String(config.collection_spend_rule.percent_off_per_step));
  const [spendMinQty, setSpendMinQty] = useState(String(config.collection_spend_rule.min_collection_qty));
  const [spendStepAmount, setSpendStepAmount] = useState(String(config.collection_spend_rule.spend_step_amount));

  const [section, setSection] = useState<Section>("order");

  const collectionOptions = [
    { label: "— Select collection —", value: "" },
    ...collections.map((c: CollectionOption) => ({ label: c.title, value: c.id })),
  ];

  const totalItemProducts = config.item_collection_rules.reduce(
    (s, r) => s + (r.product_ids?.length ?? 0), 0,
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
        enabled: hvacEnabled,
        indoor_collection_id: hvacIndoor,
        outdoor_collection_id: hvacOutdoor,
        min_indoor_per_outdoor: Number(hvacMinIndoor) || 2,
        max_indoor_per_outdoor: Number(hvacMaxIndoor) || 6,
        percent_off_hvac_products: Number(hvacPercent) || 0,
        amount_off_outdoor_per_bundle: Number(hvacAmountOff) || 0,
        indoor_product_ids: [],  // fetched server-side
        outdoor_product_ids: [], // fetched server-side
        combination_rules: config.hvac_rule.combination_rules ?? [],
      },
      collection_spend_rule: {
        enabled: toggleSpend,
        collection_id: spendCollection,
        percent_off_per_step: Number(spendPctPerStep) || 0,
        min_collection_qty: Number(spendMinQty) || 1,
        spend_step_amount: Number(spendStepAmount) || 0,
        product_ids: [], // fetched server-side
      },
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
                    <List.Item key={i}>{pc.count} products → {pc.label}</List.Item>
                  ))}
                </List>
              </Banner>
            </Layout.Section>
          )}
          {actionData?.ok === false && (
            <Layout.Section>
              <Banner tone="critical" title="Save failed">
                <List type="bullet">
                  {actionData.errors.map((e, i) => <List.Item key={i}>{e}</List.Item>)}
                </List>
              </Banner>
            </Layout.Section>
          )}

          {/* Toggles */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Discount Toggles</Text>
                <InlineStack gap="400" wrap>
                  <Checkbox label="First Order" checked={toggleFirstOrder} onChange={setToggleFirstOrder} />
                  <Checkbox label="Bulk" checked={toggleBulk} onChange={setToggleBulk} />
                  <Checkbox label="VIP (VIP3–VIP25)" checked={toggleVip} onChange={setToggleVip} />
                  <Checkbox label="Item Collection" checked={toggleItem} onChange={setToggleItem} />
                  <Checkbox label="HVAC" checked={toggleHvac} onChange={setToggleHvac} />
                  <Checkbox label="Spend Rules" checked={toggleSpend} onChange={setToggleSpend} />
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
              <Card>
                <BlockStack gap="400">
                  <Text as="h3" variant="headingSm">First Order Discount</Text>
                  <TextField
                    label="Discount % for first-time customers"
                    type="number"
                    value={firstOrderPct}
                    onChange={setFirstOrderPct}
                    autoComplete="off"
                  />
                  <Divider />
                  <Text as="h3" variant="headingSm">Bulk Tiers — by order subtotal ($)</Text>
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
            </Layout.Section>
          )}

          {/* ── Item Rules ── */}
          {section === "item" && (
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text as="h3" variant="headingSm">Item Collection Rules</Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Products in the selected collection get the specified discount %. Product IDs
                    are fetched on save — handles 2500+ products via chunked shop metafields.
                  </Text>
                  {rules.map((rule, i) => (
                    <Card key={`rule-${i}`}>
                      <BlockStack gap="200">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="h4" variant="headingSm">Rule {i + 1}</Text>
                          <Button variant="plain" tone="critical"
                            onClick={() => setRules((p) => p.filter((_, j) => j !== i))}>
                            Remove
                          </Button>
                        </InlineStack>
                        <Select
                          label="Collection"
                          options={collectionOptions}
                          value={rule.collection_id}
                          onChange={(v) => setRules((p) => p.map((r, j) => j === i ? { ...r, collection_id: v } : r))}
                        />
                        <TextField
                          label="Discount %"
                          type="number"
                          value={rule.percent}
                          onChange={(v) => setRules((p) => p.map((r, j) => j === i ? { ...r, percent: v } : r))}
                          autoComplete="off"
                        />
                      </BlockStack>
                    </Card>
                  ))}
                  <Button onClick={() => setRules((p) => [...p, { collection_id: "", percent: "5" }])}>
                    + Add Rule
                  </Button>
                </BlockStack>
              </Card>
            </Layout.Section>
          )}

          {/* ── HVAC Rules ── */}
          {section === "hvac" && (
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text as="h3" variant="headingSm">HVAC Bundle Rules</Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Customers who buy a minimum ratio of indoor to outdoor units get a bundle discount.
                    Product IDs are fetched from the selected collections on save.
                  </Text>
                  <Checkbox label="Enable HVAC rules" checked={hvacEnabled} onChange={setHvacEnabled} />
                  <Divider />
                  <Select
                    label="Indoor Products Collection"
                    options={collectionOptions}
                    value={hvacIndoor}
                    onChange={setHvacIndoor}
                  />
                  <Select
                    label="Outdoor Products Collection"
                    options={collectionOptions}
                    value={hvacOutdoor}
                    onChange={setHvacOutdoor}
                  />
                  <Divider />
                  <FormLayout>
                    <FormLayout.Group>
                      <TextField
                        label="Min indoor heads per outdoor unit"
                        type="number"
                        value={hvacMinIndoor}
                        onChange={setHvacMinIndoor}
                        helpText="e.g. 2 = customer needs at least 2 indoor units per outdoor unit"
                        autoComplete="off"
                      />
                      <TextField
                        label="Max indoor heads per outdoor unit"
                        type="number"
                        value={hvacMaxIndoor}
                        onChange={setHvacMaxIndoor}
                        helpText="Cap on how many indoor units receive the discount"
                        autoComplete="off"
                      />
                    </FormLayout.Group>
                    <FormLayout.Group>
                      <TextField
                        label="% off all HVAC products"
                        type="number"
                        value={hvacPercent}
                        onChange={setHvacPercent}
                        helpText="Applied to both indoor and outdoor units in the bundle"
                        autoComplete="off"
                      />
                      <TextField
                        label="$ amount off per outdoor unit"
                        type="number"
                        value={hvacAmountOff}
                        onChange={setHvacAmountOff}
                        helpText="Fixed dollar discount per qualifying outdoor unit"
                        autoComplete="off"
                      />
                    </FormLayout.Group>
                  </FormLayout>
                  {config.hvac_rule.indoor_product_ids.length > 0 && (
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Currently saved: {config.hvac_rule.indoor_product_ids.length} indoor /{" "}
                      {config.hvac_rule.outdoor_product_ids.length} outdoor product IDs
                    </Text>
                  )}
                </BlockStack>
              </Card>
            </Layout.Section>
          )}

          {/* ── Spend Rules ── */}
          {section === "spend" && (
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text as="h3" variant="headingSm">Collection Spend Rules</Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Customers who spend a set amount on products from this collection earn a
                    stepped discount. Product IDs are fetched from the collection on save.
                  </Text>
                  <Checkbox label="Enable collection spend rule" checked={toggleSpend} onChange={setToggleSpend} />
                  <Select
                    label="Collection"
                    options={collectionOptions}
                    value={spendCollection}
                    onChange={setSpendCollection}
                  />
                  <FormLayout>
                    <FormLayout.Group>
                      <TextField
                        label="% off per spend step"
                        type="number"
                        value={spendPctPerStep}
                        onChange={setSpendPctPerStep}
                        autoComplete="off"
                      />
                      <TextField
                        label="Spend step amount ($)"
                        type="number"
                        value={spendStepAmount}
                        onChange={setSpendStepAmount}
                        helpText="e.g. 100 = gain 1 step per $100 spent on collection products"
                        autoComplete="off"
                      />
                    </FormLayout.Group>
                    <TextField
                      label="Min collection item qty to activate"
                      type="number"
                      value={spendMinQty}
                      onChange={setSpendMinQty}
                      autoComplete="off"
                    />
                  </FormLayout>
                </BlockStack>
              </Card>
            </Layout.Section>
          )}

          {/* ── Status ── */}
          {section === "status" && (
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">Current Saved Config</Text>
                  <List type="bullet">
                    <List.Item>
                      Item rules: {config.item_collection_rules.length} —{" "}
                      <Badge tone={totalItemProducts > 0 ? "success" : "attention"}>
                        {String(totalItemProducts)} product IDs
                      </Badge>
                    </List.Item>
                    <List.Item>
                      HVAC:{" "}
                      <Badge tone={config.hvac_rule.enabled ? "success" : "attention"}>
                        {config.hvac_rule.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                      {" — "}
                      {config.hvac_rule.indoor_product_ids.length} indoor /{" "}
                      {config.hvac_rule.outdoor_product_ids.length} outdoor
                    </List.Item>
                    <List.Item>
                      Collection spend:{" "}
                      <Badge tone={config.collection_spend_rule.enabled ? "success" : "attention"}>
                        {config.collection_spend_rule.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                      {" — "}
                      {config.collection_spend_rule.product_ids.length} product IDs
                    </List.Item>
                    <List.Item>Storage: shop metafields (smart_discount_engine/config + parts 1–6)</List.Item>
                  </List>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Config is chunked at 50KB per metafield part. Max 6 parts = 300KB capacity.
                    The checkout function reads these at runtime with no Shopify query complexity cost.
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
