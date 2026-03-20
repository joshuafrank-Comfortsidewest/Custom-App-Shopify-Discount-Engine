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

type RuntimeConfig = {
  toggles: {
    first_order_enabled: boolean;
    bulk_enabled: boolean;
    vip_enabled: boolean;
    item_collection_enabled: boolean;
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
};

type ActionResult = {
  ok: boolean;
  errors: string[];
  productCounts: Array<{ collection_id: string; count: number }>;
};

// ── Constants ─────────────────────────────────────────────────────────────────

// Shopify metafield max = 65535 bytes. 50000 stays safely under.
const CHUNK_SIZE = 50_000;
const MAX_PARTS = 6; // Function reads config-part-1 through config-part-6

const DEFAULT_CONFIG: RuntimeConfig = {
  toggles: {
    first_order_enabled: true,
    bulk_enabled: true,
    vip_enabled: true,
    item_collection_enabled: true,
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
};

// ── Server Helpers ────────────────────────────────────────────────────────────

async function fetchCollections(admin: any): Promise<CollectionOption[]> {
  const res = await admin.graphql(`#graphql
    query FetchCollections {
      collections(first: 250, sortKey: TITLE) {
        nodes { id title }
      }
    }
  `);
  const data = await res.json();
  return data?.data?.collections?.nodes ?? [];
}

// Handles 2500+ products via pagination (250 per page)
async function fetchAllProductIds(admin: any, collectionId: string): Promise<string[]> {
  if (!collectionId) return [];
  const ids: string[] = [];
  let after: string | null = null;
  while (true) {
    const res = await admin.graphql(
      `#graphql
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

function parseShopConfig(
  primary: string | null,
  parts: Array<string | null>,
): RuntimeConfig {
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
    const fallback = parts
      .filter(Boolean)
      .map((p) => decodeJsonString(p!))
      .join("");
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
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

// Splits config across multiple metafields if > 50KB
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
    throw new Error(
      `Config needs ${parts.length} chunks but max is ${MAX_PARTS}. Reduce collection size.`,
    );
  }

  return { manifest: JSON.stringify({ chunked: true, parts: parts.length }), parts };
}

// ── Loader ────────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const [collections, configRes] = await Promise.all([
    fetchCollections(admin),
    admin.graphql(`#graphql
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
    return json<ActionResult>({
      ok: false,
      errors: ["Invalid config JSON submitted."],
      productCounts: [],
    });
  }

  // Fetch product IDs server-side via paginated Shopify Admin API
  const productCounts: ActionResult["productCounts"] = [];
  const item_collection_rules: ItemCollectionRule[] = await Promise.all(
    (parsed.item_collection_rules ?? []).map(async (rule) => {
      const product_ids = await fetchAllProductIds(admin, rule.collection_id);
      productCounts.push({ collection_id: rule.collection_id, count: product_ids.length });
      return { collection_id: rule.collection_id, percent: rule.percent, product_ids };
    }),
  );

  const fullConfig: RuntimeConfig = { ...parsed, item_collection_rules };

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

  // Resolve shop GID — required for shop-level metafields
  const shopRes = await admin.graphql(`#graphql query { shop { id } }`);
  const shopData = await shopRes.json();
  const shopId = shopData?.data?.shop?.id as string | undefined;

  if (!shopId) {
    return json<ActionResult>({
      ok: false,
      errors: ["Could not resolve shop ID."],
      productCounts,
    });
  }

  // Write to shop metafields (same location the Rust function reads from)
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
      value: part,
    })),
  ];

  const saveRes = await admin.graphql(
    `#graphql
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

type RuleState = { collection_id: string; percent: string };

export default function DiscountConfigRoute() {
  const { config, collections } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const formRef = useRef<HTMLFormElement>(null);
  const configInputRef = useRef<HTMLInputElement>(null);

  const [toggleFirstOrder, setToggleFirstOrder] = useState(config.toggles.first_order_enabled);
  const [toggleBulk, setToggleBulk] = useState(config.toggles.bulk_enabled);
  const [toggleVip, setToggleVip] = useState(config.toggles.vip_enabled);
  const [toggleItem, setToggleItem] = useState(config.toggles.item_collection_enabled);

  const [firstOrderPercent, setFirstOrderPercent] = useState(String(config.first_order_percent));
  const [bulk5Min, setBulk5Min] = useState(String(config.bulk5_min));
  const [bulk5Pct, setBulk5Pct] = useState(String(config.bulk5_percent));
  const [bulk10Min, setBulk10Min] = useState(String(config.bulk10_min));
  const [bulk10Pct, setBulk10Pct] = useState(String(config.bulk10_percent));
  const [bulk13Min, setBulk13Min] = useState(String(config.bulk13_min));
  const [bulk13Pct, setBulk13Pct] = useState(String(config.bulk13_percent));
  const [bulk15Min, setBulk15Min] = useState(String(config.bulk15_min));
  const [bulk15Pct, setBulk15Pct] = useState(String(config.bulk15_percent));

  const [rules, setRules] = useState<RuleState[]>(
    config.item_collection_rules.length > 0
      ? config.item_collection_rules.map((r) => ({
          collection_id: r.collection_id,
          percent: String(r.percent),
        }))
      : [],
  );

  const [section, setSection] = useState<"order" | "item" | "status">("order");

  const collectionOptions = [
    { label: "— Select collection —", value: "" },
    ...collections.map((c: CollectionOption) => ({ label: c.title, value: c.id })),
  ];

  const totalProducts = config.item_collection_rules.reduce(
    (sum, r) => sum + (r.product_ids?.length ?? 0),
    0,
  );

  const handleSubmit = (_e: React.FormEvent<HTMLFormElement>) => {
    if (!configInputRef.current) return;
    configInputRef.current.value = JSON.stringify({
      toggles: {
        first_order_enabled: toggleFirstOrder,
        bulk_enabled: toggleBulk,
        vip_enabled: toggleVip,
        item_collection_enabled: toggleItem,
        hvac_enabled: false,
      },
      first_order_percent: Number(firstOrderPercent) || 0,
      bulk5_min: Number(bulk5Min) || 0,
      bulk5_percent: Number(bulk5Pct) || 0,
      bulk10_min: Number(bulk10Min) || 0,
      bulk10_percent: Number(bulk10Pct) || 0,
      bulk13_min: Number(bulk13Min) || 0,
      bulk13_percent: Number(bulk13Pct) || 0,
      bulk15_min: Number(bulk15Min) || 0,
      bulk15_percent: Number(bulk15Pct) || 0,
      // product_ids are fetched server-side; send only collection_id + percent
      item_collection_rules: rules
        .filter((r) => r.collection_id && Number(r.percent) > 0)
        .map((r) => ({
          collection_id: r.collection_id,
          percent: Number(r.percent),
          product_ids: [],
        })),
    } satisfies RuntimeConfig);
  };

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
                <Text as="p" variant="bodyMd">
                  The checkout function will use these rules on the next cart load.
                </Text>
                {actionData.productCounts?.length > 0 && (
                  <List type="bullet">
                    {actionData.productCounts.map((pc, i) => (
                      <List.Item key={`pc-${i}`}>
                        {pc.count} products loaded from collection
                      </List.Item>
                    ))}
                  </List>
                )}
              </Banner>
            </Layout.Section>
          )}
          {actionData?.ok === false && (
            <Layout.Section>
              <Banner tone="critical" title="Save failed">
                <List type="bullet">
                  {actionData.errors.map((err, i) => (
                    <List.Item key={`err-${i}`}>{err}</List.Item>
                  ))}
                </List>
              </Banner>
            </Layout.Section>
          )}

          {/* Toggles */}
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Discount Toggles</Text>
                <InlineStack gap="500" wrap>
                  <Checkbox label="First Order" checked={toggleFirstOrder} onChange={setToggleFirstOrder} />
                  <Checkbox label="Bulk" checked={toggleBulk} onChange={setToggleBulk} />
                  <Checkbox label="VIP (tags VIP3–VIP25)" checked={toggleVip} onChange={setToggleVip} />
                  <Checkbox label="Item Collection Rules" checked={toggleItem} onChange={setToggleItem} />
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* Tab buttons */}
          <Layout.Section>
            <InlineStack gap="200">
              {(["order", "item", "status"] as const).map((key) => (
                <Button
                  key={key}
                  variant={section === key ? "primary" : "secondary"}
                  onClick={() => setSection(key)}
                >
                  {key === "order" ? "Order Rules" : key === "item" ? "Item Rules" : "Status"}
                </Button>
              ))}
            </InlineStack>
          </Layout.Section>

          {/* Order Rules */}
          {section === "order" && (
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text as="h3" variant="headingSm">First Order Discount</Text>
                  <TextField
                    label="Discount % for first-time customers"
                    type="number"
                    value={firstOrderPercent}
                    onChange={setFirstOrderPercent}
                    autoComplete="off"
                  />
                  <Divider />
                  <Text as="h3" variant="headingSm">Bulk Tiers — by order subtotal ($)</Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Customer gets the highest % tier their subtotal qualifies for.
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

          {/* Item Rules */}
          {section === "item" && (
            <Layout.Section>
              <Card>
                <BlockStack gap="400">
                  <Text as="h3" variant="headingSm">Item Collection Rules</Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Pick a collection and a discount %. On save, all product IDs are fetched
                    (250 per page, handles 2500+) and stored in shop metafields with chunking.
                    No query complexity issues — the checkout function reads metafields, not collections.
                  </Text>

                  {rules.map((rule, i) => (
                    <Card key={`rule-${i}`}>
                      <BlockStack gap="200">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="h4" variant="headingSm">Rule {i + 1}</Text>
                          <Button
                            variant="plain"
                            tone="critical"
                            onClick={() => setRules((prev) => prev.filter((_, idx) => idx !== i))}
                          >
                            Remove
                          </Button>
                        </InlineStack>
                        <Select
                          label="Collection"
                          options={collectionOptions}
                          value={rule.collection_id}
                          onChange={(v) =>
                            setRules((prev) =>
                              prev.map((r, idx) => (idx === i ? { ...r, collection_id: v } : r)),
                            )
                          }
                        />
                        <TextField
                          label="Discount %"
                          type="number"
                          value={rule.percent}
                          onChange={(v) =>
                            setRules((prev) =>
                              prev.map((r, idx) => (idx === i ? { ...r, percent: v } : r)),
                            )
                          }
                          autoComplete="off"
                        />
                      </BlockStack>
                    </Card>
                  ))}

                  <Button
                    onClick={() =>
                      setRules((prev) => [...prev, { collection_id: "", percent: "5" }])
                    }
                  >
                    + Add Rule
                  </Button>
                </BlockStack>
              </Card>
            </Layout.Section>
          )}

          {/* Status */}
          {section === "status" && (
            <Layout.Section>
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">Current Saved Config</Text>
                  <List type="bullet">
                    <List.Item>Item rules: {config.item_collection_rules.length}</List.Item>
                    <List.Item>
                      Total product IDs stored:{" "}
                      <Badge tone={totalProducts > 0 ? "success" : "attention"}>
                        {String(totalProducts)}
                      </Badge>
                    </List.Item>
                    <List.Item>
                      Storage: <strong>shop metafields</strong>{" "}
                      (smart_discount_engine/config + parts 1–6)
                    </List.Item>
                  </List>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Config is automatically chunked across multiple metafields for large datasets
                    (e.g. 2500 products ≈ 100KB splits into ~2 chunks of 50KB each, max 6 chunks = 300KB).
                    The checkout function reads these at runtime with no query complexity cost.
                  </Text>
                </BlockStack>
              </Card>
            </Layout.Section>
          )}

          {/* Save button */}
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
