import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useFetcher, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import fs from "node:fs";
import path from "node:path";

type CollectionOption = { id: string; title: string };
type AutoTagChange = { product_id: string; product_title: string; added_tags: string[]; removed_tags: string[] };
type AutoTagHistoryEntry = {
  id: string;
  created_at: string;
  mode: "tag" | "untag_discount" | "undo";
  input_skus: string[];
  target_tag: string;
  changes: AutoTagChange[];
  scheduled_undo_at: string | null;
  undone_at: string | null;
};
type AutoTagProductSnapshot = { id: string; title: string; tags: string[]; variantSkus: string[] };
type AutoTagJobStatus = {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  mode: "tag" | "untag_discount";
  targetTag: string;
  processedCount: number;
  totalCount: number;
  changedCount: number;
  skippedProtectedCount: number;
  errorCount: number;
  createdAt: string;
  updatedAt: string;
  message: string;
};
type RuleState = "any" | "active" | "inactive";
type ActivationMode =
  | "always"
  | "no_other_discounts"
  | "requires_any_xyz_active"
  | "requires_xyz_state";

type ItemRule = { collection_id: string; percent: number; product_ids: string[] };
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
type HvacCombinationRule = {
  __ui_id?: string;
  name: string;
  enabled: boolean;
  combo_brand: string;
  outdoor_source_sku: string;
  min_indoor_per_outdoor: number;
  max_indoor_per_outdoor: number;
  indoor_mode: "all" | "selected_types";
  selected_head_types: string[];
  indoor_series_mode: "all" | "selected_series";
  selected_series: string[];
  indoor_product_ids: string[];
  percent_off_hvac_products: number;
  amount_off_outdoor_per_bundle: number;
  stack_mode: "stackable" | "exclusive_best";
  outdoor_product_ids: string[];
};
const newRuleUiId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const withRuleUiIds = (rules: HvacCombinationRule[]) =>
  rules.map((r) => ({ ...r, __ui_id: r.__ui_id || newRuleUiId() }));
type CollectionSpendRule = {
  enabled: boolean;
  collection_id: string;
  amount_off_per_step: number;
  min_collection_qty: number;
  spend_step_amount: number;
  max_discounted_units_per_order: number;
  product_ids: string[];
  activation: {
    mode: ActivationMode;
    required_any: Array<"bulk" | "vip" | "first">;
    xyz_operator: "and" | "or";
    bulk_state: RuleState;
    vip_state: RuleState;
    first_state: RuleState;
  };
};

type DiscountConfig = {
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
  bulk10_min: number;
  bulk13_min: number;
  bulk15_min: number;
  bulk5_percent: number;
  bulk10_percent: number;
  bulk13_percent: number;
  bulk15_percent: number;
  item_collection_rules: ItemRule[];
  collection_spend_rule: CollectionSpendRule;
  hvac_rule: HvacRule;
  auto_tagging: {
    history: AutoTagHistoryEntry[];
  };
  cart_labels: {
    best_label: string;
    other_label: string;
    hvac_exclusive_label: string;
    hvac_stack_label: string;
  };
  block_if_any_entered_discount_code: boolean;
};

const DEFAULT_CONFIG: DiscountConfig = {
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
  bulk10_min: 10000,
  bulk13_min: 11000,
  bulk15_min: 50000,
  bulk5_percent: 5,
  bulk10_percent: 10,
  bulk13_percent: 13,
  bulk15_percent: 15,
  item_collection_rules: [{ collection_id: "", percent: 5, product_ids: [] }],
  collection_spend_rule: {
    enabled: false,
    collection_id: "",
    amount_off_per_step: 100,
    min_collection_qty: 1,
    spend_step_amount: 1500,
    max_discounted_units_per_order: 0,
    product_ids: [],
    activation: {
      mode: "always",
      required_any: ["bulk"],
      xyz_operator: "or",
      bulk_state: "any",
      vip_state: "any",
      first_state: "any",
    },
  },
  hvac_rule: {
    enabled: false,
    min_indoor_per_outdoor: 2,
    max_indoor_per_outdoor: 6,
    percent_off_hvac_products: 0,
    amount_off_outdoor_per_bundle: 0,
    indoor_product_ids: [],
    outdoor_product_ids: [],
    combination_rules: [],
  },
  auto_tagging: {
    history: [],
  },
  cart_labels: {
    best_label: "Best",
    other_label: "Other discount",
    hvac_exclusive_label: "HVAC exclusive",
    hvac_stack_label: "HVAC + base",
  },
  block_if_any_entered_discount_code: false,
};

const toNum = (v: FormDataEntryValue | null, d: number) => {
  if (v == null) return d;
  if (typeof v === "string" && v.trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const normalizeNum = (v: unknown, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const toBool = (v: FormDataEntryValue | null, d = false) =>
  v == null ? d : ["1", "true", "on"].includes(String(v).toLowerCase());
const toDiscountGid = (raw: string) =>
  raw.startsWith("gid://") ? raw : `gid://shopify/DiscountAutomaticNode/${raw}`;
const toAppDiscountOwnerGid = (discountType: string, discountId: string) => {
  const raw = String(discountId ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("gid://")) return raw;
  if (!/^\d+$/.test(raw)) return raw;
  const type = String(discountType ?? "").trim();
  if (type === "DiscountCodeApp") return `gid://shopify/DiscountCodeApp/${raw}`;
  if (type === "DiscountAutomaticApp") return `gid://shopify/DiscountAutomaticApp/${raw}`;
  return raw;
};
const deriveRuntimeOwnerIds = (...rawValues: unknown[]) => {
  const out = new Set<string>();
  const add = (value: unknown) => {
    const v = String(value ?? "").trim();
    if (!v) return;
    out.add(v);
    const nodeMatch = v.match(/^gid:\/\/shopify\/DiscountAutomaticNode\/(\d+)$/);
    if (nodeMatch) {
      const id = nodeMatch[1];
      out.add(`gid://shopify/DiscountAutomaticApp/${id}`);
      return;
    }
    const automaticAppMatch = v.match(/^gid:\/\/shopify\/DiscountAutomaticApp\/(\d+)$/);
    if (automaticAppMatch) {
      out.add(`gid://shopify/DiscountAutomaticNode/${automaticAppMatch[1]}`);
      return;
    }
    const codeAppMatch = v.match(/^gid:\/\/shopify\/DiscountCodeApp\/(\d+)$/);
    if (codeAppMatch) {
      out.add(`gid://shopify/DiscountAutomaticNode/${codeAppMatch[1]}`);
      return;
    }
    if (/^\d+$/.test(v)) {
      out.add(`gid://shopify/DiscountAutomaticNode/${v}`);
      out.add(`gid://shopify/DiscountAutomaticApp/${v}`);
    }
  };
  rawValues.forEach(add);
  return Array.from(out);
};
const bulkPercentForSubtotal = (subtotal: number, config: DiscountConfig) => {
  if (subtotal >= config.bulk15_min) return config.bulk15_percent;
  if (subtotal >= config.bulk13_min) return config.bulk13_percent;
  if (subtotal >= config.bulk10_min) return config.bulk10_percent;
  if (subtotal >= config.bulk5_min) return config.bulk5_percent;
  return 0;
};
const displayBtu = (v: unknown) => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const m = s.match(/(\d{3,5})/);
  return m ? Number(m[1]) : null;
};
type OutdoorCatalogConstraint = {
  minHeads: number;
  maxHeads: number;
  tierLabels: string[];
  allowedIndoorSourceSkus: string[];
};

function expandIndoorSourceSkuAliases(rawSku: unknown): string[] {
  const sku = String(rawSku ?? "").trim().toUpperCase();
  if (!sku) return [];
  const aliases = new Set<string>([sku]);
  // OLMO R410 indoor SKUs can appear in data as OS-09... or OS-M09...
  const withoutM = sku.replace(/^OS-M(?=\d{2}[A-Z0-9]*-)/, "OS-");
  const withM = sku.replace(/^OS-(?=\d{2}[A-Z0-9]*-)/, "OS-M");
  aliases.add(withoutM);
  aliases.add(withM);
  return Array.from(aliases).filter(Boolean);
}

function loadOutdoorCatalogConstraints(): Record<string, OutdoorCatalogConstraint> {
  try {
    const p = path.resolve("app/data/hvac/hvac-bundle-catalog.json");
    if (!fs.existsSync(p)) return {};
    const raw = fs.readFileSync(p, "utf8");
    const json = JSON.parse(raw);
    const combos = Array.isArray(json?.combos) ? json.combos : [];
    const bySku = new Map<string, OutdoorCatalogConstraint>();
    for (const combo of combos) {
      const sku = String(combo?.outdoor?.sku ?? "").trim();
      if (!sku) continue;
      const zones = Number(combo?.zones ?? 0);
      const tier = String(combo?.tier ?? "").trim();
      const indoorSlots = Array.isArray(combo?.indoorSlots) ? combo.indoorSlots : [];
      const allowed = new Set<string>();
      for (const slot of indoorSlots) {
        const skus = Array.isArray(slot?.candidateSkus) ? slot.candidateSkus : [];
        for (const s of skus) {
          for (const alias of expandIndoorSourceSkuAliases(s)) {
            if (alias) allowed.add(alias);
          }
        }
      }
      const prev = bySku.get(sku);
      if (!prev) {
        bySku.set(sku, {
          minHeads: zones > 0 ? zones : 2,
          maxHeads: zones > 0 ? zones : 6,
          tierLabels: tier ? [tier] : [],
          allowedIndoorSourceSkus: Array.from(allowed),
        });
      } else {
        prev.minHeads = zones > 0 ? Math.min(prev.minHeads, zones) : prev.minHeads;
        prev.maxHeads = zones > 0 ? Math.max(prev.maxHeads, zones) : prev.maxHeads;
        if (tier && !prev.tierLabels.includes(tier)) prev.tierLabels.push(tier);
        prev.allowedIndoorSourceSkus = Array.from(
          new Set([...prev.allowedIndoorSourceSkus, ...Array.from(allowed)]),
        );
        bySku.set(sku, prev);
      }
    }
    return Object.fromEntries(bySku.entries());
  } catch {
    return {};
  }
}
const skuBrandKey = (sku: string) => String(sku ?? "").trim().split("-")[0]?.toUpperCase() ?? "";
const inferIndoorHeadType = (opt: any) => {
  const systemRaw = String(opt?.sourceSystem ?? "").trim();
  if (systemRaw) return systemRaw;
  const sys = systemRaw.toLowerCase();
  if (sys.includes("wall")) return "Wall Mount";
  if (sys.includes("cassette") || sys.includes("ceiling cassette")) return "Ceiling Cassette";
  if (sys.includes("duct")) return "Concealed Duct";
  if (sys.includes("floor") || sys.includes("ceiling")) return "Floor/Ceiling";
  const sku = String(opt?.sourceSku ?? "").toUpperCase();
  if (/-WM-/.test(sku) || /WALL/.test(sku)) return "Wall Mount";
  if (/-CT-/.test(sku) || /-CC-/.test(sku)) return "Ceiling Cassette";
  if (/-DT-/.test(sku) || /-CD-/.test(sku)) return "Concealed Duct";
  if (/-FC-/.test(sku) || /-FM-/.test(sku)) return "Floor/Ceiling";
  return "Indoor Head";
};
const normalizeHeadType = (raw: unknown) => String(raw ?? "").trim().toLowerCase();
const norm = (raw: unknown) => String(raw ?? "").trim().toLowerCase();
const normalizeSkuPart = (raw: unknown) => {
  let s = String(raw ?? "").trim().toUpperCase().replace(/\s+/g, "");
  s = s.replace(/^(?:X\d+|\d+X)/i, "");
  s = s.replace(/(?:X\d+|\d+X)$/i, "");
  return s.trim();
};
const parseCompositeSkuTokens = (raw: unknown) =>
  String(raw ?? "")
    .split("+")
    .map((v) => normalizeSkuPart(v))
    .filter(Boolean);
const parseRequestedSkuTokens = (raw: unknown) =>
  String(raw ?? "")
    .split(/[\n,; ]+/)
    .map((v) => normalizeSkuPart(v))
    .filter(Boolean);
const isNumericOffTag = (tag: string) => /^\d+\s*off$/i.test(String(tag ?? "").trim());
const randomId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const AUTO_TAG_JOB_BATCH_SIZE = 20;
const AUTO_TAG_JOB_MAX_HISTORY_CHANGES = 250;
const AUTO_TAG_JOB_MAX_ERRORS = 120;
const autoTagRunningJobs = new Set<string>();

const parseStringArray = (raw: string | null | undefined) => {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v) => String(v ?? ""));
  } catch {
    return [];
  }
};

const parseAutoTagChanges = (raw: string | null | undefined) => {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    if (!Array.isArray(parsed)) return [] as AutoTagChange[];
    return parsed
      .map((entry: any) => ({
        product_id: String(entry?.product_id ?? "").trim(),
        product_title: String(entry?.product_title ?? "").trim(),
        added_tags: Array.isArray(entry?.added_tags)
          ? entry.added_tags.map((v: any) => String(v ?? "").trim()).filter(Boolean)
          : [],
        removed_tags: Array.isArray(entry?.removed_tags)
          ? entry.removed_tags.map((v: any) => String(v ?? "").trim()).filter(Boolean)
          : [],
      }))
      .filter((entry) => Boolean(entry.product_id));
  } catch {
    return [] as AutoTagChange[];
  }
};

const parseAutoTagMatchedProducts = (raw: string | null | undefined) => {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    if (!Array.isArray(parsed)) return [] as AutoTagProductSnapshot[];
    return parsed
      .map((entry: any) => ({
        id: String(entry?.id ?? "").trim(),
        title: String(entry?.title ?? "").trim(),
        tags: Array.isArray(entry?.tags)
          ? entry.tags.map((v: any) => String(v ?? "").trim()).filter(Boolean)
          : [],
        variantSkus: Array.isArray(entry?.variantSkus)
          ? entry.variantSkus.map((v: any) => String(v ?? "").trim()).filter(Boolean)
          : [],
      }))
      .filter((entry) => Boolean(entry.id));
  } catch {
    return [] as AutoTagProductSnapshot[];
  }
};

const toAutoTagJobStatus = (job: {
  id: string;
  status: string;
  mode: string;
  targetTag: string | null;
  processedCount: number;
  totalCount: number;
  changedCount: number;
  skippedProtectedCount: number;
  errorsJson: string;
  createdAt: Date;
  updatedAt: Date;
}) =>
  ({
    id: job.id,
    status: (job.status || "running") as AutoTagJobStatus["status"],
    mode: (job.mode || "tag") as AutoTagJobStatus["mode"],
    targetTag: String(job.targetTag ?? ""),
    processedCount: Number(job.processedCount ?? 0),
    totalCount: Number(job.totalCount ?? 0),
    changedCount: Number(job.changedCount ?? 0),
    skippedProtectedCount: Number(job.skippedProtectedCount ?? 0),
    errorCount: parseStringArray(job.errorsJson).length,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    message: "",
  }) satisfies AutoTagJobStatus;

async function processAutoTagJob(
  admin: any,
  shop: string,
  configOwnerId: string,
  jobId: string,
) {
  if (!jobId || autoTagRunningJobs.has(jobId)) return;
  autoTagRunningJobs.add(jobId);
  try {
    while (true) {
      const job = await prisma.autoTagJob.findUnique({ where: { id: jobId } });
      if (!job) break;
      if (job.status !== "running") break;

      const matched = parseAutoTagMatchedProducts(job.matchedProductsJson);
      const totalCount = Math.max(0, Number(job.totalCount ?? matched.length));
      const cursor = Math.max(0, Number(job.cursor ?? 0));
      if (cursor >= totalCount || matched.length === 0) {
        const changes = parseAutoTagChanges(job.changesJson);
        const inputSkus = parseStringArray(job.inputSkusJson);
        const operationErrors = parseStringArray(job.errorsJson);
        const [meta, shopMeta] = await Promise.all([
          loadDiscountOwnersAndConfig(admin, configOwnerId),
          loadShopConfig(admin),
        ]);
        const currentConfig = parseConfig(meta.configRaw ?? shopMeta.configRaw);
        const entry: AutoTagHistoryEntry = {
          id: randomId(),
          created_at: new Date().toISOString(),
          mode: job.mode === "untag_discount" ? "untag_discount" : "tag",
          input_skus: inputSkus,
          target_tag: String(job.targetTag ?? ""),
          changes,
          scheduled_undo_at: job.scheduledUndoAt,
          undone_at: null,
        };
        const nextConfig: DiscountConfig = {
          ...currentConfig,
          auto_tagging: {
            history: [entry, ...(currentConfig.auto_tagging?.history ?? [])].slice(0, 30),
          },
        };
        const persistJson = await persistConfig(admin, configOwnerId, nextConfig, {
          skipRuntime: true,
          shopOwnerId: shopMeta.shopId,
        });
        const persistErrors = (persistJson?.data?.metafieldsSet?.userErrors ?? []).map((e: any) =>
          String(e?.message ?? "Failed to save settings"),
        );
        const allErrors = Array.from(new Set([...operationErrors, ...persistErrors]));
        const status = allErrors.length > 0 ? "failed" : "completed";
        await prisma.autoTagJob.update({
          where: { id: jobId },
          data: {
            status,
            errorsJson: JSON.stringify(allErrors.slice(0, AUTO_TAG_JOB_MAX_ERRORS)),
          },
        });
        break;
      }

      const hvacProtectedIds = await hvacProtectedProductIds(shop);
      const discountTagTarget =
        job.mode === "tag" ? isNumericOffTag(String(job.targetTag ?? "")) : false;
      const start = cursor;
      const end = Math.min(totalCount, start + AUTO_TAG_JOB_BATCH_SIZE);
      const chunk = matched.slice(start, end);

      let changedCountDelta = 0;
      let skippedProtectedDelta = 0;
      const chunkChanges: AutoTagChange[] = [];
      const chunkErrors: string[] = [];
      for (const product of chunk) {
        const productTags = new Set(
          (Array.isArray(product.tags) ? product.tags : [])
            .map((tag) => String(tag ?? "").trim())
            .filter(Boolean),
        );
        const added: string[] = [];
        const removed: string[] = [];

        if (job.mode === "tag") {
          const targetTag = String(job.targetTag ?? "").trim();
          if (!targetTag) continue;
          if (discountTagTarget && hvacProtectedIds.has(product.id)) {
            skippedProtectedDelta += 1;
            continue;
          }

          if (discountTagTarget) {
            const existingOffTags = Array.from(productTags).filter(isNumericOffTag);
            if (existingOffTags.length > 0) {
              const errs = await tagsRemove(admin, product.id, existingOffTags);
              if (errs.length) {
                chunkErrors.push(...errs.map((msg) => `${product.title}: ${msg}`));
              } else {
                for (const tag of existingOffTags) productTags.delete(tag);
                removed.push(...existingOffTags);
              }
            }
          }

          const hasTarget = Array.from(productTags).some(
            (tag) => tag.toLowerCase() === targetTag.toLowerCase(),
          );
          if (!hasTarget) {
            const errs = await tagsAdd(admin, product.id, [targetTag]);
            if (errs.length) {
              chunkErrors.push(...errs.map((msg) => `${product.title}: ${msg}`));
            } else {
              productTags.add(targetTag);
              added.push(targetTag);
            }
          }
        } else {
          const removeTargets = Array.from(productTags).filter(isNumericOffTag);
          if (removeTargets.length > 0) {
            const errs = await tagsRemove(admin, product.id, removeTargets);
            if (errs.length) {
              chunkErrors.push(...errs.map((msg) => `${product.title}: ${msg}`));
            } else {
              for (const tag of removeTargets) productTags.delete(tag);
              removed.push(...removeTargets);
            }
          }
        }

        if (added.length || removed.length) {
          changedCountDelta += 1;
          chunkChanges.push({
            product_id: product.id,
            product_title: product.title,
            added_tags: added,
            removed_tags: removed,
          });
        }
      }

      const previousChanges = parseAutoTagChanges(job.changesJson);
      const nextChanges = [...previousChanges, ...chunkChanges].slice(0, AUTO_TAG_JOB_MAX_HISTORY_CHANGES);
      const previousErrors = parseStringArray(job.errorsJson);
      const nextErrors = [...previousErrors, ...chunkErrors].slice(0, AUTO_TAG_JOB_MAX_ERRORS);

      await prisma.autoTagJob.update({
        where: { id: jobId },
        data: {
          cursor: end,
          processedCount: end,
          changedCount: Number(job.changedCount ?? 0) + changedCountDelta,
          skippedProtectedCount: Number(job.skippedProtectedCount ?? 0) + skippedProtectedDelta,
          changesJson: JSON.stringify(nextChanges),
          errorsJson: JSON.stringify(nextErrors),
        },
      });
    }
  } catch (error: any) {
    const message = String(error?.message ?? error ?? "Unknown error");
    const job = await prisma.autoTagJob.findUnique({ where: { id: jobId } });
    if (job) {
      const existingErrors = parseStringArray(job.errorsJson);
      await prisma.autoTagJob.update({
        where: { id: jobId },
        data: {
          status: "failed",
          errorsJson: JSON.stringify([...existingErrors, message].slice(0, AUTO_TAG_JOB_MAX_ERRORS)),
        },
      });
    }
  } finally {
    autoTagRunningJobs.delete(jobId);
  }
}
async function hvacProtectedProductIds(shop: string) {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT DISTINCT "mappedProductId"
     FROM "HvacSkuMapping"
     WHERE "shop" = ? AND "sourceType" IN ('indoor','outdoor') AND "mappedProductId" IS NOT NULL`,
    shop,
  )) as Array<{ mappedProductId: string | null }>;
  return new Set(rows.map((r) => String(r?.mappedProductId ?? "").trim()).filter(Boolean));
}

async function listProductsForTagging(admin: any) {
  const out: Array<{ id: string; title: string; tags: string[]; variantSkus: string[] }> = [];
  let after: string | null = null;
  while (true) {
    const res: any = await admin.graphql(
      `#graphql
      query ProductsForTagging($after: String) {
        products(first: 100, after: $after) {
          nodes {
            id
            title
            tags
            variants(first: 100) { nodes { sku } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { variables: { after } },
    );
    const json: any = await res.json();
    const block: any = json?.data?.products;
    const nodes = block?.nodes ?? [];
    for (const n of nodes) {
      out.push({
        id: String(n?.id ?? ""),
        title: String(n?.title ?? ""),
        tags: Array.isArray(n?.tags) ? n.tags.map((t: any) => String(t)) : [],
        variantSkus: Array.isArray(n?.variants?.nodes)
          ? n.variants.nodes.map((v: any) => String(v?.sku ?? ""))
          : [],
      });
    }
    if (!block?.pageInfo?.hasNextPage) break;
    after = block?.pageInfo?.endCursor ?? null;
    if (!after) break;
  }
  return out;
}

async function tagsAdd(admin: any, productId: string, tags: string[]): Promise<string[]> {
  if (!tags.length) return [];
  const response = await admin.graphql(
    `#graphql
    mutation AddTags($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }`,
    { variables: { id: productId, tags } },
  );
  const json = await response.json();
  const errors: string[] = [];
  for (const e of json?.errors ?? []) errors.push(String(e?.message ?? "GraphQL error"));
  for (const e of json?.data?.tagsAdd?.userErrors ?? []) {
    errors.push(String(e?.message ?? "tagsAdd error"));
  }
  return errors;
}

async function tagsRemove(admin: any, productId: string, tags: string[]): Promise<string[]> {
  if (!tags.length) return [];
  const response = await admin.graphql(
    `#graphql
    mutation RemoveTags($id: ID!, $tags: [String!]!) {
      tagsRemove(id: $id, tags: $tags) {
        userErrors { field message }
      }
    }`,
    { variables: { id: productId, tags } },
  );
  const json = await response.json();
  const errors: string[] = [];
  for (const e of json?.errors ?? []) errors.push(String(e?.message ?? "GraphQL error"));
  for (const e of json?.data?.tagsRemove?.userErrors ?? []) {
    errors.push(String(e?.message ?? "tagsRemove error"));
  }
  return errors;
}

const FUNCTION_CONFIG_MAX_BYTES = 10_000;
const FUNCTION_CONFIG_CHUNK_MAX_BYTES = 50_000;
const FUNCTION_CONFIG_KEY = "function-configuration";
const ADMIN_CONFIG_KEY = "admin-configuration";
const FUNCTION_CONFIG_CHUNK_KEY_PREFIX = "function-configuration-part-";
const FUNCTION_CONFIG_MAX_CHUNKS = 2;
const ADMIN_CONFIG_CHUNK_KEY_PREFIX = "admin-configuration-part-";
const ADMIN_CONFIG_MAX_CHUNKS = 8;
const SHOP_RUNTIME_MIRROR_NAMESPACE = "smart_discount_engine";
const SHOP_RUNTIME_MIRROR_KEY = "config";
const SHOP_RUNTIME_APP_MIRROR_NAMESPACE = "$app:smart_discount_engine";

function splitUtf8ByBytes(input: string, maxBytes: number): string[] {
  if (maxBytes <= 0) return [input];
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of input) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (current && currentBytes + chBytes > maxBytes) {
      chunks.push(current);
      current = ch;
      currentBytes = chBytes;
    } else {
      current += ch;
      currentBytes += chBytes;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [""];
}

function resolveChunkedConfigJson(
  primary: string | null | undefined,
  chunks: Array<string | null | undefined>,
): string | null {
  const primaryRaw = String(primary ?? "").trim();
  if (!primaryRaw) return null;
  try {
    const parsed = JSON.parse(primaryRaw) as { chunked?: boolean; parts?: number };
    if (parsed?.chunked) {
      const parts = Math.max(0, Math.min(Number(parsed?.parts ?? 0), chunks.length));
      if (parts <= 0) return null;
      let joined = "";
      for (let i = 0; i < parts; i += 1) {
        const part = String(chunks[i] ?? "");
        if (!part) return null;
        joined += part;
      }
      return joined || null;
    }
  } catch {
    // Primary value is plain JSON config; return as-is.
  }
  return primaryRaw;
}

function compactProductId(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const match = raw.match(/^gid:\/\/shopify\/Product\/(\d+)$/);
  return match ? match[1] : raw;
}

function compactProductIds(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out: string[] = [];
  for (const value of values) {
    const compacted = compactProductId(value);
    if (compacted) out.push(compacted);
  }
  return Array.from(new Set(out));
}

function buildRuntimeFunctionConfig(config: DiscountConfig) {
  const itemRulesEnabled = Boolean(config.toggles?.item_collection_enabled);
  const otherRuleEnabled = Boolean(config.toggles?.collection_spend_enabled || config.collection_spend_rule?.enabled);
  const hvacRuleEnabled = Boolean(config.toggles?.hvac_enabled || config.hvac_rule?.enabled);

  const runtimeItemCollectionRules = itemRulesEnabled
    ? (config.item_collection_rules ?? [])
        .map((rule) => ({
          collection_id: String(rule?.collection_id ?? "").trim(),
          percent: normalizeNum(rule?.percent, 0),
          product_ids: compactProductIds(rule?.product_ids),
        }))
        .filter((rule) => rule.collection_id && rule.percent > 0 && rule.product_ids.length > 0)
    : [];

  const runtimeCollectionSpendRule = otherRuleEnabled
    ? {
        enabled: true,
        collection_id: String(config.collection_spend_rule?.collection_id ?? "").trim(),
        amount_off_per_step: normalizeNum(
          config.collection_spend_rule?.amount_off_per_step,
          DEFAULT_CONFIG.collection_spend_rule.amount_off_per_step,
        ),
        min_collection_qty: normalizeNum(
          config.collection_spend_rule?.min_collection_qty,
          DEFAULT_CONFIG.collection_spend_rule.min_collection_qty,
        ),
        spend_step_amount: normalizeNum(
          config.collection_spend_rule?.spend_step_amount,
          DEFAULT_CONFIG.collection_spend_rule.spend_step_amount,
        ),
        max_discounted_units_per_order: Math.max(
          0,
          normalizeNum(
            config.collection_spend_rule?.max_discounted_units_per_order,
            DEFAULT_CONFIG.collection_spend_rule.max_discounted_units_per_order,
          ),
        ),
        product_ids: compactProductIds(config.collection_spend_rule?.product_ids),
        activation: {
          ...DEFAULT_CONFIG.collection_spend_rule.activation,
          ...(config.collection_spend_rule?.activation ?? {}),
        },
      }
    : {
        ...DEFAULT_CONFIG.collection_spend_rule,
        enabled: false,
        collection_id: "",
        product_ids: [],
        activation: {
          ...DEFAULT_CONFIG.collection_spend_rule.activation,
        },
      };

  const runtimeHvacCombinationRules = hvacRuleEnabled
    ? (config.hvac_rule?.combination_rules ?? [])
        .map((rule) => ({
          name: String(rule?.name ?? "").trim(),
          enabled: Boolean(rule?.enabled),
          outdoor_source_sku: String(rule?.outdoor_source_sku ?? "").trim(),
          min_indoor_per_outdoor: normalizeNum(
            rule?.min_indoor_per_outdoor,
            config.hvac_rule?.min_indoor_per_outdoor ?? DEFAULT_CONFIG.hvac_rule.min_indoor_per_outdoor,
          ),
          max_indoor_per_outdoor: normalizeNum(
            rule?.max_indoor_per_outdoor,
            config.hvac_rule?.max_indoor_per_outdoor ?? DEFAULT_CONFIG.hvac_rule.max_indoor_per_outdoor,
          ),
          indoor_product_ids: compactProductIds(rule?.indoor_product_ids),
          percent_off_hvac_products: normalizeNum(rule?.percent_off_hvac_products, 0),
          amount_off_outdoor_per_bundle: normalizeNum(rule?.amount_off_outdoor_per_bundle, 0),
          stack_mode: rule?.stack_mode === "exclusive_best" ? "exclusive_best" : "stackable",
          outdoor_product_ids: compactProductIds(rule?.outdoor_product_ids),
        }))
    : [];

  const runtimeHvacRule = {
    enabled: hvacRuleEnabled,
    min_indoor_per_outdoor: normalizeNum(
      config.hvac_rule?.min_indoor_per_outdoor,
      DEFAULT_CONFIG.hvac_rule.min_indoor_per_outdoor,
    ),
    max_indoor_per_outdoor: normalizeNum(
      config.hvac_rule?.max_indoor_per_outdoor,
      DEFAULT_CONFIG.hvac_rule.max_indoor_per_outdoor,
    ),
    percent_off_hvac_products: normalizeNum(config.hvac_rule?.percent_off_hvac_products, 0),
    amount_off_outdoor_per_bundle: normalizeNum(config.hvac_rule?.amount_off_outdoor_per_bundle, 0),
    indoor_product_ids: [],
    outdoor_product_ids: [],
    combination_rules: runtimeHvacCombinationRules,
  };

  const includeLegacyItemFallback = runtimeItemCollectionRules.length === 0;

  return {
    toggles: config.toggles,
    first_order_percent: config.first_order_percent,
    bulk5_min: config.bulk5_min,
    bulk10_min: config.bulk10_min,
    bulk13_min: config.bulk13_min,
    bulk15_min: config.bulk15_min,
    bulk5_percent: config.bulk5_percent,
    bulk10_percent: config.bulk10_percent,
    bulk13_percent: config.bulk13_percent,
    bulk15_percent: config.bulk15_percent,
    item_collection_rules: runtimeItemCollectionRules,
    collection_spend_rule: runtimeCollectionSpendRule,
    hvac_rule: runtimeHvacRule,
    cart_labels: config.cart_labels,
    block_if_any_entered_discount_code: config.block_if_any_entered_discount_code,
    return_conflict_enabled: config.return_conflict_enabled,
    return_blocked_codes: config.return_blocked_codes,
    item_collection_5_percent: includeLegacyItemFallback
      ? config.item_collection_5_percent
      : 5,
    item_collection_10_percent: includeLegacyItemFallback
      ? config.item_collection_10_percent
      : 10,
    collection_5_product_ids: includeLegacyItemFallback
      ? compactProductIds(config.collection_5_product_ids)
      : [],
    collection_10_product_ids: includeLegacyItemFallback
      ? compactProductIds(config.collection_10_product_ids)
      : [],
  };
}

function buildAdminConfiguration(config: DiscountConfig): DiscountConfig {
  return {
    ...config,
    item_collection_rules: (config.item_collection_rules ?? []).map((rule) => ({
      collection_id: String(rule?.collection_id ?? "").trim(),
      percent: normalizeNum(rule?.percent, 0),
      // Product IDs are derived at save-time; keep admin payload lean.
      product_ids: [],
    })),
    collection_spend_rule: {
      ...config.collection_spend_rule,
      // Product IDs are derived from collection on save.
      product_ids: [],
    },
    hvac_rule: {
      ...config.hvac_rule,
      // Keep heavy mapped ID arrays out of admin config to avoid size limits.
      indoor_product_ids: [],
      outdoor_product_ids: [],
      combination_rules: (config.hvac_rule?.combination_rules ?? []).map((rule) => ({
        ...rule,
        indoor_product_ids: [],
        outdoor_product_ids: [],
      })),
    },
  };
}

async function persistConfig(
  admin: any,
  ownerId: string,
  config: DiscountConfig,
  options?: { skipRuntime?: boolean; shopOwnerId?: string; runtimeOwnerIds?: string[] },
) {
  const payload = JSON.stringify(buildAdminConfiguration(config));
  const skipRuntime = Boolean(options?.skipRuntime);
  const cleanedShopOwnerId = String(options?.shopOwnerId ?? "").trim();
  const runtimePayload = skipRuntime
    ? ""
    : JSON.stringify(buildRuntimeFunctionConfig(config));
  const cleanedOwnerId = String(ownerId ?? "").trim();
  const runtimeOwnerIds = Array.from(
    new Set(
      (options?.runtimeOwnerIds ?? [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  );
  if (runtimeOwnerIds.length === 0 && cleanedOwnerId) {
    runtimeOwnerIds.push(cleanedOwnerId);
  }
  if (!cleanedOwnerId) {
    return {
      data: {
        metafieldsSet: {
          userErrors: [{ field: ["ownerId"], message: "Missing discount owner ID" }],
        },
      },
    };
  }
  const runtimeMetafields: Array<{
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
  }> = [];
  const adminMetafields: Array<{
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
  }> = [];
  let adminWarning: string | null = null;
  let runtimeWarning: string | null = null;
  const runtimeMirrorMetafields: Array<{
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
  }> = [];
  const adminBytes = Buffer.byteLength(payload, "utf8");
  if (adminBytes <= FUNCTION_CONFIG_MAX_BYTES) {
    adminMetafields.push({
      ownerId: cleanedOwnerId,
      namespace: "$app",
      key: ADMIN_CONFIG_KEY,
      type: "json",
      value: payload,
    });
  } else {
    const chunks = splitUtf8ByBytes(payload, FUNCTION_CONFIG_CHUNK_MAX_BYTES);
    if (chunks.length > ADMIN_CONFIG_MAX_CHUNKS) {
      adminWarning = `Admin settings are too large (${adminBytes} bytes). Reduce Auto Tagging history or number of very large rules, then save again.`;
    } else {
      adminMetafields.push({
        ownerId: cleanedOwnerId,
        namespace: "$app",
        key: ADMIN_CONFIG_KEY,
        type: "json",
        value: JSON.stringify({ chunked: true, parts: chunks.length }),
      });
      chunks.forEach((chunk, idx) => {
        adminMetafields.push({
          ownerId: cleanedOwnerId,
          namespace: "$app",
          key: `${ADMIN_CONFIG_CHUNK_KEY_PREFIX}${idx + 1}`,
          type: "multi_line_text_field",
          value: chunk,
        });
      });
    }
  }
  if (!skipRuntime) {
    const runtimeBytes = Buffer.byteLength(runtimePayload, "utf8");

    if (runtimeBytes <= FUNCTION_CONFIG_MAX_BYTES) {
      for (const runtimeOwnerId of runtimeOwnerIds) {
        runtimeMetafields.push({
          ownerId: runtimeOwnerId,
          namespace: "$app",
          key: FUNCTION_CONFIG_KEY,
          type: "json",
          value: runtimePayload,
        });
      }
    } else {
      const chunks = splitUtf8ByBytes(runtimePayload, FUNCTION_CONFIG_CHUNK_MAX_BYTES);
      if (chunks.length > FUNCTION_CONFIG_MAX_CHUNKS) {
        runtimeWarning = `Runtime function config is too large (${runtimeBytes} bytes). Settings were saved, but checkout runtime was not updated. Reduce selected item/HVAC products or use fewer large collection rules, then save again.`;
      } else {
        for (const runtimeOwnerId of runtimeOwnerIds) {
          runtimeMetafields.push({
            ownerId: runtimeOwnerId,
            namespace: "$app",
            key: FUNCTION_CONFIG_KEY,
            type: "json",
            value: JSON.stringify({ chunked: true, parts: chunks.length }),
          });
          chunks.forEach((chunk, idx) => {
            runtimeMetafields.push({
              ownerId: runtimeOwnerId,
              namespace: "$app",
              key: `${FUNCTION_CONFIG_CHUNK_KEY_PREFIX}${idx + 1}`,
              type: "multi_line_text_field",
              value: chunk,
            });
          });
        }
      }
    }
    if (runtimeMetafields.length > 0 && cleanedShopOwnerId) {
      runtimeMirrorMetafields.push(
        {
          ownerId: cleanedShopOwnerId,
          namespace: SHOP_RUNTIME_APP_MIRROR_NAMESPACE,
          key: SHOP_RUNTIME_MIRROR_KEY,
          type: "json",
          value: runtimePayload,
        },
        {
          ownerId: cleanedShopOwnerId,
          namespace: SHOP_RUNTIME_MIRROR_NAMESPACE,
          key: SHOP_RUNTIME_MIRROR_KEY,
          type: "json",
          value: runtimePayload,
        },
      );
    }
  }

  const setMetafields = async (metafields: Array<{
    ownerId: string;
    namespace: string;
    key: string;
    type: string;
    value: string;
  }>) => {
    const response = await admin.graphql(
      `#graphql
      mutation m($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { field message } }
      }`,
      { variables: { metafields } },
    );
    return response.json();
  };

  const userErrors: Array<{ field: string[]; message: string }> = [];

  if (adminMetafields.length > 0) {
    const adminJson = await setMetafields(adminMetafields);
    for (const e of adminJson?.data?.metafieldsSet?.userErrors ?? []) {
      userErrors.push({
        field: Array.isArray(e?.field) ? e.field : ["adminConfiguration"],
        message: String(e?.message ?? "Unknown error"),
      });
    }
    for (const e of adminJson?.errors ?? []) {
      userErrors.push({ field: ["graphql"], message: String(e?.message ?? "GraphQL error") });
    }
  }
  if (adminWarning) {
    userErrors.push({ field: ["admin"], message: adminWarning });
  }

  let runtimePersistSucceeded = false;
  if (runtimeMetafields.length > 0) {
    const runtimeJson = await setMetafields(runtimeMetafields);
    const runtimeUserErrors = runtimeJson?.data?.metafieldsSet?.userErrors ?? [];
    const runtimeGraphQLErrors = runtimeJson?.errors ?? [];
    for (const e of runtimeJson?.data?.metafieldsSet?.userErrors ?? []) {
      userErrors.push({
        field: Array.isArray(e?.field) ? e.field : ["runtimeConfiguration"],
        message: String(e?.message ?? "Unknown error"),
      });
    }
    for (const e of runtimeJson?.errors ?? []) {
      userErrors.push({ field: ["graphql"], message: String(e?.message ?? "GraphQL error") });
    }
    runtimePersistSucceeded = runtimeUserErrors.length === 0 && runtimeGraphQLErrors.length === 0;
  }

  if (runtimePersistSucceeded && runtimeMirrorMetafields.length > 0) {
    const mirrorJson = await setMetafields(runtimeMirrorMetafields);
    for (const e of mirrorJson?.data?.metafieldsSet?.userErrors ?? []) {
      userErrors.push({
        field: Array.isArray(e?.field) ? e.field : ["runtimeMirrorConfiguration"],
        message: String(e?.message ?? "Unknown error"),
      });
    }
    for (const e of mirrorJson?.errors ?? []) {
      userErrors.push({ field: ["graphql"], message: String(e?.message ?? "GraphQL error") });
    }
  }

  if (runtimeWarning) {
    userErrors.push({ field: ["runtime"], message: runtimeWarning });
  }

  return {
    data: {
      metafieldsSet: {
        userErrors,
      },
    },
  };
}

async function loadDiscountOwnersAndConfig(admin: any, discountGid: string) {
  const response = await admin.graphql(
    `#graphql
      query q($id: ID!) {
        discountNode(id: $id) {
          id
          adminConfiguration: metafield(namespace: "$app", key: "admin-configuration") { value }
          adminConfigurationPart1: metafield(namespace: "$app", key: "admin-configuration-part-1") { value }
          adminConfigurationPart2: metafield(namespace: "$app", key: "admin-configuration-part-2") { value }
          adminConfigurationPart3: metafield(namespace: "$app", key: "admin-configuration-part-3") { value }
          adminConfigurationPart4: metafield(namespace: "$app", key: "admin-configuration-part-4") { value }
          adminConfigurationPart5: metafield(namespace: "$app", key: "admin-configuration-part-5") { value }
          adminConfigurationPart6: metafield(namespace: "$app", key: "admin-configuration-part-6") { value }
          adminConfigurationPart7: metafield(namespace: "$app", key: "admin-configuration-part-7") { value }
          adminConfigurationPart8: metafield(namespace: "$app", key: "admin-configuration-part-8") { value }
          canonicalConfiguration: metafield(namespace: "$app", key: "function-configuration") { value }
          functionConfiguration: metafield(key: "function-configuration") { value }
          appMetafield: metafield(namespace: "$app:smart_discount_engine", key: "config") { value }
          legacyMetafield: metafield(namespace: "smart_discount_engine", key: "config") { value }
          discount {
            __typename
            ... on DiscountAutomaticApp {
              discountId
            }
            ... on DiscountCodeApp {
              discountId
            }
          }
        }
      }`,
    { variables: { id: discountGid } },
  );
  const json = await response.json();
  const node = json?.data?.discountNode;
  const nodeId = String(node?.id ?? "").trim();
  const discountType = String(node?.discount?.__typename ?? "").trim();
  const discountId = String(node?.discount?.discountId ?? "").trim();
  const discountOwnerId = toAppDiscountOwnerGid(discountType, discountId);
  const adminConfigRaw = resolveChunkedConfigJson(node?.adminConfiguration?.value, [
    node?.adminConfigurationPart1?.value,
    node?.adminConfigurationPart2?.value,
    node?.adminConfigurationPart3?.value,
    node?.adminConfigurationPart4?.value,
    node?.adminConfigurationPart5?.value,
    node?.adminConfigurationPart6?.value,
    node?.adminConfigurationPart7?.value,
    node?.adminConfigurationPart8?.value,
  ]);
  const configRaw =
    adminConfigRaw ??
    node?.canonicalConfiguration?.value ??
    node?.functionConfiguration?.value ??
    node?.appMetafield?.value ??
    node?.legacyMetafield?.value ??
    null;
  return { nodeId, discountOwnerId, discountId, discountType, configRaw };
}

async function loadShopConfig(admin: any) {
  const response = await admin.graphql(
    `#graphql
      query shopConfig {
        shop {
          id
          adminConfiguration: metafield(namespace: "$app", key: "admin-configuration") { value }
          adminConfigurationPart1: metafield(namespace: "$app", key: "admin-configuration-part-1") { value }
          adminConfigurationPart2: metafield(namespace: "$app", key: "admin-configuration-part-2") { value }
          adminConfigurationPart3: metafield(namespace: "$app", key: "admin-configuration-part-3") { value }
          adminConfigurationPart4: metafield(namespace: "$app", key: "admin-configuration-part-4") { value }
          adminConfigurationPart5: metafield(namespace: "$app", key: "admin-configuration-part-5") { value }
          adminConfigurationPart6: metafield(namespace: "$app", key: "admin-configuration-part-6") { value }
          adminConfigurationPart7: metafield(namespace: "$app", key: "admin-configuration-part-7") { value }
          adminConfigurationPart8: metafield(namespace: "$app", key: "admin-configuration-part-8") { value }
          canonicalConfiguration: metafield(namespace: "$app", key: "function-configuration") { value }
          functionConfiguration: metafield(key: "function-configuration") { value }
          appMetafield: metafield(namespace: "$app:smart_discount_engine", key: "config") { value }
          legacyMetafield: metafield(namespace: "smart_discount_engine", key: "config") { value }
        }
      }`,
  );
  const json = await response.json();
  const shop = json?.data?.shop;
  const shopId = String(shop?.id ?? "").trim();
  const adminConfigRaw = resolveChunkedConfigJson(shop?.adminConfiguration?.value, [
    shop?.adminConfigurationPart1?.value,
    shop?.adminConfigurationPart2?.value,
    shop?.adminConfigurationPart3?.value,
    shop?.adminConfigurationPart4?.value,
    shop?.adminConfigurationPart5?.value,
    shop?.adminConfigurationPart6?.value,
    shop?.adminConfigurationPart7?.value,
    shop?.adminConfigurationPart8?.value,
  ]);
  const configRaw =
    adminConfigRaw ??
    shop?.canonicalConfiguration?.value ??
    shop?.functionConfiguration?.value ??
    shop?.appMetafield?.value ??
    shop?.legacyMetafield?.value ??
    null;
  return { shopId, configRaw };
}

async function fetchCollections(admin: any): Promise<CollectionOption[]> {
  const response = await admin.graphql(`#graphql
    query {
      collections(first: 100, sortKey: TITLE) { nodes { id title } }
    }`);
  const json = await response.json();
  return json?.data?.collections?.nodes ?? [];
}

async function fetchCollectionProductIds(admin: any, collectionId: string): Promise<string[]> {
  if (!collectionId) return [];
  const ids: string[] = [];
  let after: string | null = null;
  while (true) {
    const response: any = await admin.graphql(
      `#graphql
      query q($id: ID!, $after: String) {
        collection(id: $id) {
          products(first: 250, after: $after) {
            nodes { id }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { variables: { id: collectionId, after } },
    );
    const json: any = await response.json();
    const block: any = json?.data?.collection?.products;
    if (!block) break;
    for (const n of block.nodes ?? []) if (n?.id) ids.push(String(n.id));
    if (!block.pageInfo?.hasNextPage) break;
    after = block.pageInfo.endCursor ?? null;
  }
  return ids;
}

function parseConfig(raw: string | null | undefined): DiscountConfig {
  if (!raw) return DEFAULT_CONFIG;
  try {
    const p = JSON.parse(raw);
    const merged: DiscountConfig = {
      ...DEFAULT_CONFIG,
      ...p,
      toggles: { ...DEFAULT_CONFIG.toggles, ...(p.toggles ?? {}) },
      auto_tagging: { ...DEFAULT_CONFIG.auto_tagging, ...(p.auto_tagging ?? {}) },
      cart_labels: { ...DEFAULT_CONFIG.cart_labels, ...(p.cart_labels ?? {}) },
      collection_spend_rule: {
        ...DEFAULT_CONFIG.collection_spend_rule,
        ...(p.collection_spend_rule ?? {}),
        amount_off_per_step: Number(
          p.collection_spend_rule?.amount_off_per_step ??
            p.collection_spend_rule?.percent_off_per_step ??
            DEFAULT_CONFIG.collection_spend_rule.amount_off_per_step,
        ),
        max_discounted_units_per_order: Number(
          p.collection_spend_rule?.max_discounted_units_per_order ??
            DEFAULT_CONFIG.collection_spend_rule.max_discounted_units_per_order,
        ),
        activation: {
          ...DEFAULT_CONFIG.collection_spend_rule.activation,
          ...(p.collection_spend_rule?.activation ?? {}),
        },
      },
      hvac_rule: {
        ...DEFAULT_CONFIG.hvac_rule,
        ...(p.hvac_rule ?? {}),
        combination_rules: Array.isArray(p.hvac_rule?.combination_rules)
          ? p.hvac_rule.combination_rules
          : DEFAULT_CONFIG.hvac_rule.combination_rules,
      },
      item_collection_rules: Array.isArray(p.item_collection_rules)
        ? p.item_collection_rules
        : DEFAULT_CONFIG.item_collection_rules,
    };

    const parsed = {
      ...merged,
      first_order_percent:
        normalizeNum(merged.first_order_percent, DEFAULT_CONFIG.first_order_percent) <= 0
          ? DEFAULT_CONFIG.first_order_percent
          : normalizeNum(merged.first_order_percent, DEFAULT_CONFIG.first_order_percent),
      bulk5_min:
        normalizeNum(merged.bulk5_min, DEFAULT_CONFIG.bulk5_min) <= 0
          ? DEFAULT_CONFIG.bulk5_min
          : normalizeNum(merged.bulk5_min, DEFAULT_CONFIG.bulk5_min),
      bulk10_min:
        normalizeNum(merged.bulk10_min, DEFAULT_CONFIG.bulk10_min) <= 0
          ? DEFAULT_CONFIG.bulk10_min
          : normalizeNum(merged.bulk10_min, DEFAULT_CONFIG.bulk10_min),
      bulk13_min:
        normalizeNum(merged.bulk13_min, DEFAULT_CONFIG.bulk13_min) <= 0
          ? DEFAULT_CONFIG.bulk13_min
          : normalizeNum(merged.bulk13_min, DEFAULT_CONFIG.bulk13_min),
      bulk15_min:
        normalizeNum(merged.bulk15_min, DEFAULT_CONFIG.bulk15_min) <= 0
          ? DEFAULT_CONFIG.bulk15_min
          : normalizeNum(merged.bulk15_min, DEFAULT_CONFIG.bulk15_min),
      bulk5_percent:
        normalizeNum(merged.bulk5_percent, DEFAULT_CONFIG.bulk5_percent) <= 0
          ? DEFAULT_CONFIG.bulk5_percent
          : normalizeNum(merged.bulk5_percent, DEFAULT_CONFIG.bulk5_percent),
      bulk10_percent:
        normalizeNum(merged.bulk10_percent, DEFAULT_CONFIG.bulk10_percent) <= 0
          ? DEFAULT_CONFIG.bulk10_percent
          : normalizeNum(merged.bulk10_percent, DEFAULT_CONFIG.bulk10_percent),
      bulk13_percent:
        normalizeNum(merged.bulk13_percent, DEFAULT_CONFIG.bulk13_percent) <= 0
          ? DEFAULT_CONFIG.bulk13_percent
          : normalizeNum(merged.bulk13_percent, DEFAULT_CONFIG.bulk13_percent),
      bulk15_percent:
        normalizeNum(merged.bulk15_percent, DEFAULT_CONFIG.bulk15_percent) <= 0
          ? DEFAULT_CONFIG.bulk15_percent
          : normalizeNum(merged.bulk15_percent, DEFAULT_CONFIG.bulk15_percent),
      collection_spend_rule: {
        ...merged.collection_spend_rule,
        amount_off_per_step:
          normalizeNum(
            merged.collection_spend_rule.amount_off_per_step,
            DEFAULT_CONFIG.collection_spend_rule.amount_off_per_step,
          ) <= 0
            ? DEFAULT_CONFIG.collection_spend_rule.amount_off_per_step
            : normalizeNum(
                merged.collection_spend_rule.amount_off_per_step,
                DEFAULT_CONFIG.collection_spend_rule.amount_off_per_step,
              ),
        min_collection_qty:
          normalizeNum(
            merged.collection_spend_rule.min_collection_qty,
            DEFAULT_CONFIG.collection_spend_rule.min_collection_qty,
          ) <= 0
            ? DEFAULT_CONFIG.collection_spend_rule.min_collection_qty
            : normalizeNum(
                merged.collection_spend_rule.min_collection_qty,
                DEFAULT_CONFIG.collection_spend_rule.min_collection_qty,
              ),
        spend_step_amount:
          normalizeNum(
            merged.collection_spend_rule.spend_step_amount,
            DEFAULT_CONFIG.collection_spend_rule.spend_step_amount,
          ) <= 0
            ? DEFAULT_CONFIG.collection_spend_rule.spend_step_amount
            : normalizeNum(
                merged.collection_spend_rule.spend_step_amount,
                DEFAULT_CONFIG.collection_spend_rule.spend_step_amount,
              ),
        max_discounted_units_per_order: Math.max(
          0,
          normalizeNum(
            merged.collection_spend_rule.max_discounted_units_per_order,
            DEFAULT_CONFIG.collection_spend_rule.max_discounted_units_per_order,
          ),
        ),
      },
      hvac_rule: {
        ...merged.hvac_rule,
        min_indoor_per_outdoor:
          normalizeNum(
            merged.hvac_rule.min_indoor_per_outdoor,
            DEFAULT_CONFIG.hvac_rule.min_indoor_per_outdoor,
          ) <= 0
            ? DEFAULT_CONFIG.hvac_rule.min_indoor_per_outdoor
            : normalizeNum(
                merged.hvac_rule.min_indoor_per_outdoor,
                DEFAULT_CONFIG.hvac_rule.min_indoor_per_outdoor,
              ),
        max_indoor_per_outdoor:
          normalizeNum(
            merged.hvac_rule.max_indoor_per_outdoor,
            DEFAULT_CONFIG.hvac_rule.max_indoor_per_outdoor,
          ) <= 0
            ? DEFAULT_CONFIG.hvac_rule.max_indoor_per_outdoor
            : normalizeNum(
                merged.hvac_rule.max_indoor_per_outdoor,
                DEFAULT_CONFIG.hvac_rule.max_indoor_per_outdoor,
              ),
        percent_off_hvac_products: normalizeNum(
          merged.hvac_rule.percent_off_hvac_products,
          DEFAULT_CONFIG.hvac_rule.percent_off_hvac_products,
        ),
        amount_off_outdoor_per_bundle: normalizeNum(
          merged.hvac_rule.amount_off_outdoor_per_bundle,
          DEFAULT_CONFIG.hvac_rule.amount_off_outdoor_per_bundle,
        ),
        combination_rules: Array.isArray(merged.hvac_rule.combination_rules)
          ? merged.hvac_rule.combination_rules
              .map((r: any) => {
                const stackMode: "stackable" | "exclusive_best" =
                  r?.stack_mode === "exclusive_best" ? "exclusive_best" : "stackable";
                const indoorMode: "all" | "selected_types" =
                  r?.indoor_mode === "selected_types" ? "selected_types" : "all";
                const indoorSeriesMode: "all" | "selected_series" =
                  r?.indoor_series_mode === "selected_series" ? "selected_series" : "all";
                return {
                  name: String(r?.name ?? "").trim(),
                  enabled: Boolean(r?.enabled),
                  combo_brand: String(r?.combo_brand ?? "").trim(),
                  outdoor_source_sku: String(r?.outdoor_source_sku ?? "").trim(),
                  min_indoor_per_outdoor: normalizeNum(
                    r?.min_indoor_per_outdoor,
                    DEFAULT_CONFIG.hvac_rule.min_indoor_per_outdoor,
                  ),
                  max_indoor_per_outdoor: normalizeNum(
                    r?.max_indoor_per_outdoor,
                    DEFAULT_CONFIG.hvac_rule.max_indoor_per_outdoor,
                  ),
                  indoor_mode: indoorMode,
                  selected_head_types: Array.isArray(r?.selected_head_types)
                    ? r.selected_head_types.map((v: any) => normalizeHeadType(v)).filter(Boolean)
                    : [],
                  indoor_series_mode: indoorSeriesMode,
                  selected_series: Array.isArray(r?.selected_series)
                    ? r.selected_series.map((v: any) => String(v ?? "").trim()).filter(Boolean)
                    : [],
                  indoor_product_ids: Array.isArray(r?.indoor_product_ids)
                    ? r.indoor_product_ids.map((v: any) => String(v))
                    : [],
                  percent_off_hvac_products: normalizeNum(r?.percent_off_hvac_products, 0),
                  amount_off_outdoor_per_bundle: normalizeNum(r?.amount_off_outdoor_per_bundle, 0),
                  stack_mode: stackMode,
                  outdoor_product_ids: Array.isArray(r?.outdoor_product_ids)
                    ? r.outdoor_product_ids.map((v: any) => String(v))
                    : [],
                };
              })
          : [],
      },
    };
    return {
      ...parsed,
      toggles: {
        ...parsed.toggles,
        // Keep top toggle in sync with inner "Enable this rule" state.
        collection_spend_enabled:
          parsed.toggles.collection_spend_enabled || parsed.collection_spend_rule.enabled,
        hvac_enabled: parsed.toggles.hvac_enabled,
      },
      collection_spend_rule: {
        ...parsed.collection_spend_rule,
        enabled:
          parsed.collection_spend_rule.enabled || parsed.toggles.collection_spend_enabled,
      },
      hvac_rule: {
        ...parsed.hvac_rule,
        enabled: parsed.hvac_rule.enabled,
      },
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function detectConflicts(config: DiscountConfig) {
  const map = new Map<string, string[]>();
  config.item_collection_rules.forEach((r, idx) => {
    for (const pid of r.product_ids ?? []) {
      const list = map.get(pid) ?? [];
      list.push(`item-${idx + 1}`);
      map.set(pid, list);
    }
  });
  // Do not treat "Other Discounts" collection membership as a hard conflict.
  // Review conflicts should represent overlap across multiple item-rule collections.
  return Array.from(map.entries())
    .filter(([, v]) => new Set(v).size > 1)
    .slice(0, 10)
    .map(([product_id, rules]) => ({ product_id, rules: Array.from(new Set(rules)) }));
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const id = params.id ?? "";
  const discountGid = toDiscountGid(id);
  const [collections, discountMeta, shopMeta] = await Promise.all([
    fetchCollections(admin),
    loadDiscountOwnersAndConfig(admin, discountGid),
    loadShopConfig(admin),
  ]);
  const hvacOutdoorOptions = (await prisma.$queryRawUnsafe(
    `SELECT "sourceSku", "mappedProductId", "mappedProductTitle", "sourceBrand", "sourceSeries", "sourceSystem", "sourceRefrigerant",
            CAST("sourceBtu" AS TEXT) AS "sourceBtu"
     FROM "HvacSkuMapping"
     WHERE "shop" = ? AND "sourceType" = 'outdoor' AND "mappedProductId" IS NOT NULL
     ORDER BY "sourceSku" ASC`,
    session.shop,
  )) as Array<{
    sourceSku: string;
    mappedProductId: string | null;
    mappedProductTitle: string | null;
    sourceBrand: string | null;
    sourceSeries: string | null;
    sourceSystem: string | null;
    sourceRefrigerant: string | null;
    sourceBtu: string | null;
  }>;
  const hvacIndoorOptions = (await prisma.$queryRawUnsafe(
    `SELECT "sourceSku", "mappedProductId", "mappedProductTitle", "sourceBrand", "sourceSeries", "sourceSystem", "sourceRefrigerant",
            CAST("sourceBtu" AS TEXT) AS "sourceBtu"
     FROM "HvacSkuMapping"
     WHERE "shop" = ? AND "sourceType" = 'indoor' AND "mappedProductId" IS NOT NULL
     ORDER BY "sourceSku" ASC`,
    session.shop,
  )) as Array<{
    sourceSku: string;
    mappedProductId: string | null;
    mappedProductTitle: string | null;
    sourceBrand: string | null;
    sourceSeries: string | null;
    sourceSystem: string | null;
    sourceRefrigerant: string | null;
    sourceBtu: string | null;
  }>;
  const outdoorCatalogConstraints = loadOutdoorCatalogConstraints();
  const config = parseConfig(discountMeta.configRaw ?? shopMeta.configRaw);
  const configOwnerId = String(discountMeta.nodeId || discountGid || "").trim();
  const activeAutoTagJobRow = configOwnerId
    ? await prisma.autoTagJob.findFirst({
        where: { shop: session.shop, discountNodeId: configOwnerId, status: "running" },
        orderBy: { createdAt: "desc" },
      })
    : null;
  const activeAutoTagJob = activeAutoTagJobRow ? toAutoTagJobStatus(activeAutoTagJobRow) : null;
  return {
    id,
    config,
    collections,
    conflicts: detectConflicts(config),
    hvacOutdoorOptions,
    hvacIndoorOptions,
    outdoorCatalogConstraints,
    activeAutoTagJob,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const id = params.id ?? "";
  const discountGid = toDiscountGid(id);
  const fd = await request.formData();
  const intent = String(fd.get("intent") ?? "").trim();
  const outdoorCatalogConstraints = loadOutdoorCatalogConstraints();
  const [currentMeta, shopMeta] = await Promise.all([
    loadDiscountOwnersAndConfig(admin, discountGid),
    loadShopConfig(admin),
  ]);
  const configOwnerId = String(currentMeta.nodeId || discountGid || "").trim();
  const current = parseConfig(currentMeta.configRaw ?? shopMeta.configRaw);
  const collectionProductIdsCache = new Map<string, string[]>();
  const getCollectionProductIdsCached = async (collectionId: string) => {
    const id = String(collectionId ?? "").trim();
    if (!id) return [];
    if (collectionProductIdsCache.has(id)) {
      return collectionProductIdsCache.get(id) ?? [];
    }
    const ids = await fetchCollectionProductIds(admin, id);
    collectionProductIdsCache.set(id, ids);
    return ids;
  };

  if (intent === "auto_tag_apply") {
    const mode = String(fd.get("auto_tag_mode") ?? "tag") === "untag_discount" ? "untag_discount" : "tag";
    const inputSkus = Array.from(new Set(parseRequestedSkuTokens(fd.get("auto_tag_skus"))));
    const targetTag = String(fd.get("auto_tag_target_tag") ?? "").trim();
    const scheduleUndoAtRaw = String(fd.get("auto_tag_schedule_undo_at") ?? "").trim();
    const scheduleUndoAt = (() => {
      if (!scheduleUndoAtRaw) return null;
      const t = Date.parse(scheduleUndoAtRaw);
      if (!Number.isFinite(t)) return null;
      return new Date(t).toISOString();
    })();
    if (inputSkus.length === 0) {
      return { ok: false, message: "Enter at least one SKU token." };
    }
    if (mode === "tag" && !targetTag) {
      return { ok: false, message: "Enter a tag name to apply." };
    }

    const existingRunning = await prisma.autoTagJob.findFirst({
      where: { shop: session.shop, discountNodeId: configOwnerId, status: "running" },
      orderBy: { createdAt: "desc" },
    });
    if (existingRunning) {
      return {
        ok: false,
        message: "An auto-tag job is already running. Wait for it to finish.",
        activeTab: "autoTags",
        autoTagJob: toAutoTagJobStatus(existingRunning),
      };
    }

    const products = await listProductsForTagging(admin);
    const tokenSet = new Set(inputSkus.map((s) => s.toUpperCase()));
    const matched = products.filter((p) => {
      const variantTokens = new Set(
        p.variantSkus.flatMap((sku) => parseCompositeSkuTokens(sku).map((v) => v.toUpperCase())),
      );
      for (const t of tokenSet) if (variantTokens.has(t)) return true;
      return false;
    });
    if (matched.length === 0) {
      return {
        ok: false,
        message: "No listings matched those SKU tokens.",
        activeTab: "autoTags",
      };
    }

    const job = await prisma.autoTagJob.create({
      data: {
        shop: session.shop,
        discountNodeId: configOwnerId,
        status: "running",
        mode,
        targetTag: targetTag || null,
        scheduledUndoAt: scheduleUndoAt,
        inputSkusJson: JSON.stringify(inputSkus),
        matchedProductsJson: JSON.stringify(
          matched.map((p) => ({
            id: p.id,
            title: p.title,
            tags: p.tags,
            variantSkus: p.variantSkus,
          })),
        ),
        changesJson: "[]",
        errorsJson: "[]",
        cursor: 0,
        processedCount: 0,
        totalCount: matched.length,
        changedCount: 0,
        skippedProtectedCount: 0,
      },
    });
    void processAutoTagJob(admin, session.shop, configOwnerId, job.id);
    return {
      ok: true,
      message: `Started auto-tag job for ${matched.length} listing(s). You can leave this page and check progress later.`,
      activeTab: "autoTags",
      autoTagJob: toAutoTagJobStatus(job),
    };
  }

  if (intent === "auto_tag_job_poll") {
    const jobId = String(fd.get("auto_tag_job_id") ?? "").trim();
    if (!jobId) {
      return { ok: false, activeTab: "autoTags", message: "Missing job id." };
    }
    const job = await prisma.autoTagJob.findUnique({ where: { id: jobId } });
    if (!job || job.shop !== session.shop || job.discountNodeId !== configOwnerId) {
      return { ok: false, activeTab: "autoTags", message: "Job not found." };
    }
    if (job.status === "running") {
      void processAutoTagJob(admin, session.shop, configOwnerId, job.id);
    }
    const jobStatus = toAutoTagJobStatus(job);
    const pct =
      jobStatus.totalCount > 0
        ? Math.floor((jobStatus.processedCount / jobStatus.totalCount) * 100)
        : 100;
    const done = jobStatus.status !== "running";
    return {
      ok: jobStatus.status === "completed",
      activeTab: "autoTags",
      autoTagJob: jobStatus,
      message: done
        ? `Auto-tag job ${jobStatus.status}. Processed ${jobStatus.processedCount}/${jobStatus.totalCount}.`
        : `Auto-tag job running: ${pct}% (${jobStatus.processedCount}/${jobStatus.totalCount}).`,
    };
  }

  if (intent === "auto_tag_undo" || intent === "auto_tag_run_due") {
    const history = [...(current.auto_tagging?.history ?? [])];
    const hvacProtectedIds = await hvacProtectedProductIds(session.shop);
    const now = Date.now();
    const targetId = String(fd.get("auto_tag_history_id") ?? "").trim();
    const operationErrors: string[] = [];
    const shouldUndo = (h: AutoTagHistoryEntry) => {
      if (h.undone_at) return false;
      if (intent === "auto_tag_undo") return h.id === targetId;
      if (!h.scheduled_undo_at) return false;
      const t = Date.parse(h.scheduled_undo_at);
      return Number.isFinite(t) && t <= now;
    };
    let undone = 0;
    let skippedProtected = 0;
    const undoEntries: AutoTagHistoryEntry[] = [];
    for (const h of history) {
      if (!shouldUndo(h)) continue;
      const reverseChanges: AutoTagChange[] = [];
      for (const c of h.changes ?? []) {
        const undoRemovedPlanned = Array.isArray(c.added_tags) ? c.added_tags : [];
        const undoAddedPlanned = Array.isArray(c.removed_tags) ? c.removed_tags : [];
        const undoRemoved = [...undoRemovedPlanned];
        let undoAdded = [...undoAddedPlanned];
        if (hvacProtectedIds.has(c.product_id)) {
          const before = undoAdded.length;
          undoAdded = undoAdded.filter((t) => !isNumericOffTag(t));
          skippedProtected += before - undoAdded.length;
        }
        if (undoRemoved.length) {
          const errs = await tagsRemove(admin, c.product_id, undoRemoved);
          if (errs.length) {
            operationErrors.push(
              ...errs.map((msg) => `${c.product_title}: ${msg}`),
            );
          }
        }
        if (undoAdded.length) {
          const errs = await tagsAdd(admin, c.product_id, undoAdded);
          if (errs.length) {
            operationErrors.push(
              ...errs.map((msg) => `${c.product_title}: ${msg}`),
            );
          }
        }
        if (undoRemovedPlanned.length || undoAddedPlanned.length) {
          reverseChanges.push({
            product_id: c.product_id,
            product_title: c.product_title,
            // Keep intended reverse tags in history so operators can audit undo intent,
            // even if some were skipped due to HVAC protection.
            added_tags: undoAddedPlanned,
            removed_tags: undoRemovedPlanned,
          });
        }
      }
      h.undone_at = new Date().toISOString();
      undoEntries.push({
        id: randomId(),
        created_at: new Date().toISOString(),
        mode: "undo",
        input_skus: h.input_skus ?? [],
        target_tag: h.target_tag ?? "",
        changes: reverseChanges,
        scheduled_undo_at: null,
        undone_at: null,
      });
      undone += 1;
    }
    const next: DiscountConfig = {
      ...current,
      auto_tagging: { history: [...undoEntries, ...history].slice(0, 30) },
    };
    const persistJson = await persistConfig(admin, configOwnerId, next, {
      skipRuntime: true,
      shopOwnerId: shopMeta.shopId,
    });
    const persistErrors = (persistJson?.data?.metafieldsSet?.userErrors ?? []).map((e: any) =>
      String(e?.message ?? "Failed to save settings"),
    );
    operationErrors.push(...persistErrors.map((msg) => `History: ${msg}`));
    const protectedMsg =
      skippedProtected > 0
        ? ` Skipped re-adding ${skippedProtected} discount tag(s) on HVAC indoor/outdoor listings.`
        : "";
    const uniqueErrors = Array.from(new Set(operationErrors));
    if (uniqueErrors.length > 0) {
      const hasScopeError = uniqueErrors.some((msg) =>
        /access denied|scope|permission/i.test(msg),
      );
      const scopeHint = hasScopeError
        ? " Add `write_products` to app scopes and re-auth the app."
        : "";
      return {
        ok: false,
        message: `Undid ${undone} history entr${undone === 1 ? "y" : "ies"}.${protectedMsg} ${uniqueErrors
          .slice(0, 3)
          .join(" | ")}${scopeHint}`,
        activeTab: "autoTags",
      };
    }
    return {
      ok: true,
      message: `Undid ${undone} history entr${undone === 1 ? "y" : "ies"}.${protectedMsg}`,
      activeTab: "autoTags",
    };
  }

  const itemRulesJsonRawEncoded = String(fd.get("item_rules_json") ?? "").trim();
  const itemRulesJsonRaw = itemRulesJsonRawEncoded
    ? (() => {
        try {
          return decodeURIComponent(itemRulesJsonRawEncoded);
        } catch {
          return itemRulesJsonRawEncoded;
        }
      })()
    : "";
  let itemRulesFromJson: Array<{ collection_id: string; percent: number }> | null = null;
  if (itemRulesJsonRaw) {
    try {
      const parsed = JSON.parse(itemRulesJsonRaw);
      if (Array.isArray(parsed)) {
        itemRulesFromJson = parsed.map((r: any) => ({
          collection_id: String(r?.collection_id ?? "").trim(),
          percent: Number(r?.percent ?? 0),
        }));
      }
    } catch {
      itemRulesFromJson = null;
    }
  }
  const ruleCount = toNum(fd.get("item_rule_count"), 0);
  const hasItemInputs = fd.has("item_rule_collection_0") || ruleCount === 0;
  const item_collection_rules = itemRulesFromJson
    ? await Promise.all(
        itemRulesFromJson
          .filter((r) => r.collection_id && Number.isFinite(r.percent) && r.percent > 0)
          .map(async (r) => ({
            collection_id: r.collection_id,
            percent: r.percent,
            product_ids: await getCollectionProductIdsCached(r.collection_id),
          })),
      )
    : hasItemInputs
      ? await (async () => {
          const rules = [];
          for (let i = 0; i < ruleCount; i += 1) {
            const collection_id = String(fd.get(`item_rule_collection_${i}`) ?? "").trim();
            const percent = toNum(fd.get(`item_rule_percent_${i}`), 0);
            if (collection_id && percent > 0) rules.push({ collection_id, percent });
          }
          return Promise.all(
            rules.map(async (r) => ({
              ...r,
              product_ids: await getCollectionProductIdsCached(r.collection_id),
            })),
          );
        })()
      : current.item_collection_rules;

  const hasOtherDiscountInputs =
    fd.has("collection_spend_collection_id") || fd.has("collection_spend_amount_off");
  const csCollectionId = hasOtherDiscountInputs
    ? String(fd.get("collection_spend_collection_id") ?? "").trim()
    : current.collection_spend_rule.collection_id;
  const csProductIds = csCollectionId
    ? await getCollectionProductIdsCached(csCollectionId)
    : [];
  const mappedRows = await prisma.hvacSkuMapping.findMany({
    where: { shop: session.shop, mappedProductId: { not: null } },
    select: { sourceType: true, sourceSku: true, mappedProductId: true },
  });
  const indoorTypeRows = (await prisma.$queryRawUnsafe(
    `SELECT "sourceSku", "sourceSystem", "sourceSeries", "sourceBrand", "sourceRefrigerant"
     FROM "HvacSkuMapping"
     WHERE "shop" = ? AND "sourceType" = 'indoor' AND "mappedProductId" IS NOT NULL`,
    session.shop,
  )) as Array<{
    sourceSku: string;
    sourceSystem: string | null;
    sourceSeries: string | null;
    sourceBrand: string | null;
    sourceRefrigerant: string | null;
  }>;
  const outdoorMetaRows = (await prisma.$queryRawUnsafe(
    `SELECT "sourceSku", "sourceBrand", "sourceRefrigerant"
     FROM "HvacSkuMapping"
     WHERE "shop" = ? AND "sourceType" = 'outdoor' AND "mappedProductId" IS NOT NULL`,
    session.shop,
  )) as Array<{ sourceSku: string; sourceBrand: string | null; sourceRefrigerant: string | null }>;
  const headTypeBySku = new Map<string, string>();
  const seriesBySku = new Map<string, string>();
  const indoorBrandBySku = new Map<string, string>();
  const indoorRefrigerantBySku = new Map<string, string>();
  const outdoorBrandBySku = new Map<string, string>();
  const outdoorRefrigerantBySku = new Map<string, string>();
  for (const r of outdoorMetaRows) {
    const sku = String(r.sourceSku ?? "").trim();
    if (!sku) continue;
    if (r.sourceBrand && String(r.sourceBrand).trim()) {
      outdoorBrandBySku.set(sku, String(r.sourceBrand).trim());
    }
    if (r.sourceRefrigerant && String(r.sourceRefrigerant).trim()) {
      outdoorRefrigerantBySku.set(sku, String(r.sourceRefrigerant).trim());
    }
  }
  for (const r of indoorTypeRows) {
    const sku = String(r.sourceSku ?? "").trim();
    if (!sku) continue;
    const headType = normalizeHeadType(
      r.sourceSystem && String(r.sourceSystem).trim()
        ? r.sourceSystem
        : inferIndoorHeadType({ sourceSku: sku, sourceSystem: r.sourceSystem }),
    );
    if (headType) headTypeBySku.set(sku, headType);
    if (r.sourceSeries && String(r.sourceSeries).trim()) {
      seriesBySku.set(sku, String(r.sourceSeries).trim());
    }
    if (r.sourceBrand && String(r.sourceBrand).trim()) {
      indoorBrandBySku.set(sku, String(r.sourceBrand).trim());
    }
    if (r.sourceRefrigerant && String(r.sourceRefrigerant).trim()) {
      indoorRefrigerantBySku.set(sku, String(r.sourceRefrigerant).trim());
    }
  }
  const hvacIndoorProductIds = Array.from(
    new Set(
      mappedRows
        .filter((r) => r.sourceType !== "outdoor")
        .map((r) => String(r.mappedProductId))
        .filter(Boolean),
    ),
  );
  const hvacOutdoorProductIds = Array.from(
    new Set(
      mappedRows
        .filter((r) => r.sourceType === "outdoor")
        .map((r) => String(r.mappedProductId))
        .filter(Boolean),
    ),
  );
  const hvacOutdoorBySourceSku = new Map<string, string[]>();
  const hvacIndoorBySourceSku = new Map<string, string[]>();
  for (const row of mappedRows) {
    if (row.sourceType !== "outdoor" && row.sourceType !== "indoor") continue;
    const sku = String(row.sourceSku);
    const pid = String(row.mappedProductId ?? "");
    if (!sku || !pid) continue;
    if (row.sourceType === "outdoor") {
      const list = hvacOutdoorBySourceSku.get(sku) ?? [];
      list.push(pid);
      hvacOutdoorBySourceSku.set(sku, Array.from(new Set(list)));
    } else {
      const list = hvacIndoorBySourceSku.get(sku) ?? [];
      list.push(pid);
      hvacIndoorBySourceSku.set(sku, Array.from(new Set(list)));
    }
  }
  const comboRuleCountFromForm = Math.max(
    0,
    Math.trunc(toNum(fd.get("hvac_combo_rule_count"), 0)),
  );
  const hvacComboRulesJsonRawEncoded = String(fd.get("hvac_combo_rules_json") ?? "").trim();
  const hvacComboRulesJsonRaw = hvacComboRulesJsonRawEncoded
    ? (() => {
        try {
          return decodeURIComponent(hvacComboRulesJsonRawEncoded);
        } catch {
          return hvacComboRulesJsonRawEncoded;
        }
      })()
    : "";
  let hvacComboRulesFromJson: Array<any> | null = null;
  if (hvacComboRulesJsonRaw) {
    try {
      const parsed = JSON.parse(hvacComboRulesJsonRaw);
      if (Array.isArray(parsed)) {
        hvacComboRulesFromJson = parsed;
      }
    } catch {
      hvacComboRulesFromJson = null;
    }
  }
  const hasHvacComboFieldInputs =
    comboRuleCountFromForm === 0 || fd.has("hvac_combo_name_0") || fd.has("hvac_combo_outdoor_sku_0");
  const hasHvacComboInputs =
    hasHvacComboFieldInputs || (Array.isArray(hvacComboRulesFromJson) && hvacComboRulesFromJson.length > 0);
  const comboRuleCount = hasHvacComboFieldInputs
    ? comboRuleCountFromForm
    : hvacComboRulesFromJson?.length ?? 0;
  const hvacCombinationRules: HvacCombinationRule[] = [];
  for (let i = 0; i < comboRuleCount; i += 1) {
    const jsonRule = hasHvacComboFieldInputs ? null : hvacComboRulesFromJson?.[i] ?? null;
    const outdoorSourceSku = String(
      jsonRule?.outdoor_source_sku ?? fd.get(`hvac_combo_outdoor_sku_${i}`) ?? "",
    ).trim();
    if (!outdoorSourceSku) {
      hvacCombinationRules.push({
        name:
          String(jsonRule?.name ?? fd.get(`hvac_combo_name_${i}`) ?? "").trim() ||
          `Rule ${i + 1}`,
        enabled:
          jsonRule != null
            ? Boolean(jsonRule?.enabled)
            : toBool(fd.get(`hvac_combo_enabled_${i}`), true),
        combo_brand: String(
          jsonRule?.combo_brand ?? fd.get(`hvac_combo_brand_${i}`) ?? "",
        ).trim(),
        outdoor_source_sku: "",
        min_indoor_per_outdoor: 2,
        max_indoor_per_outdoor: 6,
        indoor_mode:
          String(jsonRule?.indoor_mode ?? fd.get(`hvac_combo_indoor_mode_${i}`) ?? "all") ===
          "selected_types"
            ? "selected_types"
            : "all",
        selected_head_types:
          jsonRule != null
            ? (Array.isArray(jsonRule?.selected_head_types)
                ? jsonRule.selected_head_types
                : []
              )
                .map((v: any) => normalizeHeadType(v))
                .filter(Boolean)
            : fd
                .getAll(`hvac_combo_head_type_${i}`)
                .map((v) => normalizeHeadType(v))
                .filter(Boolean),
        indoor_series_mode:
          String(
            jsonRule?.indoor_series_mode ??
              fd.get(`hvac_combo_indoor_series_mode_${i}`) ??
              "all",
          ) === "selected_series"
            ? "selected_series"
            : "all",
        selected_series:
          jsonRule != null
            ? (Array.isArray(jsonRule?.selected_series) ? jsonRule.selected_series : [])
                .map((v: any) => String(v ?? "").trim())
                .filter(Boolean)
            : fd
                .getAll(`hvac_combo_series_${i}`)
                .map((v) => String(v ?? "").trim())
                .filter(Boolean),
        indoor_product_ids: [],
        percent_off_hvac_products: toNum(
          jsonRule?.percent_off_hvac_products ?? fd.get(`hvac_combo_percent_${i}`),
          0,
        ),
        amount_off_outdoor_per_bundle: toNum(
          jsonRule?.amount_off_outdoor_per_bundle ?? fd.get(`hvac_combo_amount_${i}`),
          0,
        ),
        stack_mode:
          String(jsonRule?.stack_mode ?? fd.get(`hvac_combo_stack_mode_${i}`) ?? "stackable") ===
          "exclusive_best"
            ? "exclusive_best"
            : "stackable",
        outdoor_product_ids: [],
      });
      continue;
    }
    const outdoorProductIds = hvacOutdoorBySourceSku.get(outdoorSourceSku) ?? [];
    const c = outdoorCatalogConstraints[outdoorSourceSku];
    const indoorMode =
      String(jsonRule?.indoor_mode ?? fd.get(`hvac_combo_indoor_mode_${i}`) ?? "all") ===
      "selected_types"
        ? "selected_types"
        : "all";
    const indoorSeriesMode =
      String(
        jsonRule?.indoor_series_mode ?? fd.get(`hvac_combo_indoor_series_mode_${i}`) ?? "all",
      ) === "selected_series"
        ? "selected_series"
        : "all";
    const selectedHeadTypes =
      jsonRule != null
        ? (Array.isArray(jsonRule?.selected_head_types) ? jsonRule.selected_head_types : [])
            .map((v: any) => normalizeHeadType(v))
            .filter(Boolean)
        : fd
            .getAll(`hvac_combo_head_type_${i}`)
            .map((v) => normalizeHeadType(v))
            .filter(Boolean);
    const selectedSeries =
      jsonRule != null
        ? (Array.isArray(jsonRule?.selected_series) ? jsonRule.selected_series : [])
            .map((v: any) => String(v ?? "").trim())
            .filter(Boolean)
        : fd
            .getAll(`hvac_combo_series_${i}`)
            .map((v) => String(v ?? "").trim())
            .filter(Boolean);
    const selectedHeadTypeSet = new Set(selectedHeadTypes);
    const selectedSeriesSet = new Set(selectedSeries);
    const selectedRuleBrand = String(
      jsonRule?.combo_brand ?? fd.get(`hvac_combo_brand_${i}`) ?? "",
    ).trim();
    const resolvedRuleBrand =
      selectedRuleBrand || String(outdoorBrandBySku.get(outdoorSourceSku) ?? "").trim();
    const ruleBrand = resolvedRuleBrand;
    const ruleRefrigerant = String(outdoorRefrigerantBySku.get(outdoorSourceSku) ?? "").trim();
    const allowedIndoorSourceSkuSet = new Set(
      Array.isArray(c?.allowedIndoorSourceSkus)
        ? c.allowedIndoorSourceSkus
            .map((sku) => String(sku ?? "").trim().toUpperCase())
            .filter(Boolean)
        : [],
    );
    const baseIndoorSourceSkus = Array.from(hvacIndoorBySourceSku.keys());
    const constrainedIndoorSourceSkus =
      allowedIndoorSourceSkuSet.size > 0
        ? baseIndoorSourceSkus.filter((sku) =>
            allowedIndoorSourceSkuSet.has(String(sku ?? "").trim().toUpperCase()),
          )
        : baseIndoorSourceSkus;
    const brandRefrigerantFilteredSourceSkus = constrainedIndoorSourceSkus.filter((sku) => {
      const indoorBrand = String(indoorBrandBySku.get(sku) ?? "").trim();
      const indoorRefrigerant = String(indoorRefrigerantBySku.get(sku) ?? "").trim();
      const brandOk = Boolean(ruleBrand) && Boolean(indoorBrand) && norm(indoorBrand) === norm(ruleBrand);
      const refrigerantOk =
        Boolean(ruleRefrigerant) &&
        Boolean(indoorRefrigerant) &&
        norm(indoorRefrigerant) === norm(ruleRefrigerant);
      return brandOk && refrigerantOk;
    });
    const eligibleIndoorSourceSkus =
      indoorMode === "selected_types" && selectedHeadTypeSet.size > 0
        ? brandRefrigerantFilteredSourceSkus.filter((sku) =>
            selectedHeadTypeSet.has(
              normalizeHeadType(
                headTypeBySku.get(sku) ?? inferIndoorHeadType({ sourceSku: sku, sourceSystem: "" }),
              ),
            ),
          )
        : brandRefrigerantFilteredSourceSkus;
    const seriesFilteredIndoorSourceSkus =
      indoorSeriesMode === "selected_series" && selectedSeriesSet.size > 0
        ? eligibleIndoorSourceSkus.filter((sku) =>
            selectedSeriesSet.has(seriesBySku.get(sku) ?? ""),
          )
        : eligibleIndoorSourceSkus;
    let indoorProductIds =
      (indoorMode === "selected_types" && selectedHeadTypeSet.size === 0) ||
      (indoorSeriesMode === "selected_series" && selectedSeriesSet.size === 0)
        ? []
        : seriesFilteredIndoorSourceSkus.length > 0
        ? Array.from(
            new Set(
              seriesFilteredIndoorSourceSkus.flatMap((sku) => hvacIndoorBySourceSku.get(sku) ?? []),
            ),
          )
        : [];
    if (indoorProductIds.length === 0 && jsonRule != null && Array.isArray(jsonRule?.indoor_product_ids)) {
      indoorProductIds = jsonRule.indoor_product_ids
        .map((v: any) => String(v ?? "").trim())
        .filter(Boolean);
    }
    hvacCombinationRules.push({
      name:
        String(jsonRule?.name ?? fd.get(`hvac_combo_name_${i}`) ?? "").trim() ||
        `Rule ${i + 1}`,
      enabled:
        jsonRule != null
          ? Boolean(jsonRule?.enabled)
          : toBool(fd.get(`hvac_combo_enabled_${i}`), true),
      combo_brand: resolvedRuleBrand,
      outdoor_source_sku: outdoorSourceSku,
      min_indoor_per_outdoor: c?.minHeads ?? 2,
      max_indoor_per_outdoor: c?.maxHeads ?? 6,
      indoor_mode: indoorMode,
      selected_head_types: selectedHeadTypes,
      indoor_series_mode: indoorSeriesMode,
      selected_series: selectedSeries,
      indoor_product_ids: indoorProductIds,
      percent_off_hvac_products: toNum(
        jsonRule?.percent_off_hvac_products ?? fd.get(`hvac_combo_percent_${i}`),
        0,
      ),
      amount_off_outdoor_per_bundle: toNum(
        jsonRule?.amount_off_outdoor_per_bundle ?? fd.get(`hvac_combo_amount_${i}`),
        0,
      ),
      stack_mode:
        String(jsonRule?.stack_mode ?? fd.get(`hvac_combo_stack_mode_${i}`) ?? "stackable") ===
        "exclusive_best"
          ? "exclusive_best"
          : "stackable",
      outdoor_product_ids: outdoorProductIds,
    });
  }

  const config: DiscountConfig = {
    toggles: {
      first_order_enabled: toBool(
        fd.get("toggle_first_order_enabled"),
        current.toggles.first_order_enabled,
      ),
      bulk_enabled: toBool(fd.get("toggle_bulk_enabled"), current.toggles.bulk_enabled),
      vip_enabled: toBool(fd.get("toggle_vip_enabled"), current.toggles.vip_enabled),
      item_collection_enabled: toBool(
        fd.get("toggle_item_collection_enabled"),
        current.toggles.item_collection_enabled,
      ),
      collection_spend_enabled: false, // resolved below
      hvac_enabled: false, // resolved below
    },
    first_order_percent: toNum(fd.get("first_order_percent"), current.first_order_percent),
    bulk5_min: toNum(fd.get("bulk5_min"), current.bulk5_min),
    bulk10_min: toNum(fd.get("bulk10_min"), current.bulk10_min),
    bulk13_min: toNum(fd.get("bulk13_min"), current.bulk13_min),
    bulk15_min: toNum(fd.get("bulk15_min"), current.bulk15_min),
    bulk5_percent: toNum(fd.get("bulk5_percent"), current.bulk5_percent),
    bulk10_percent: toNum(fd.get("bulk10_percent"), current.bulk10_percent),
    bulk13_percent: toNum(fd.get("bulk13_percent"), current.bulk13_percent),
    bulk15_percent: toNum(fd.get("bulk15_percent"), current.bulk15_percent),
    item_collection_rules,
    collection_spend_rule: {
      enabled: false, // resolved below
      collection_id: csCollectionId,
      amount_off_per_step: toNum(
        fd.get("collection_spend_amount_off"),
        current.collection_spend_rule.amount_off_per_step,
      ),
      min_collection_qty: toNum(
        fd.get("collection_spend_min_qty"),
        current.collection_spend_rule.min_collection_qty,
      ),
      spend_step_amount: toNum(
        fd.get("collection_spend_step_amount"),
        current.collection_spend_rule.spend_step_amount,
      ),
      max_discounted_units_per_order: Math.max(
        0,
        toNum(
          fd.get("collection_spend_max_units_per_order"),
          current.collection_spend_rule.max_discounted_units_per_order,
        ),
      ),
      product_ids: csProductIds,
      activation: {
        mode: hasOtherDiscountInputs
          ? ((String(fd.get("collection_spend_activation_mode") ?? "always") ||
              "always") as ActivationMode)
          : current.collection_spend_rule.activation.mode,
        required_any: hasOtherDiscountInputs
          ? (["bulk", "vip", "first"].filter((k) =>
              toBool(fd.get(`collection_spend_required_${k}`)),
            ) as Array<"bulk" | "vip" | "first">)
          : current.collection_spend_rule.activation.required_any,
        xyz_operator: hasOtherDiscountInputs
          ? (String(fd.get("collection_spend_xyz_operator") ?? "or") === "and" ? "and" : "or")
          : current.collection_spend_rule.activation.xyz_operator,
        bulk_state: hasOtherDiscountInputs
          ? ((String(fd.get("collection_spend_bulk_state") ?? "any") || "any") as RuleState)
          : current.collection_spend_rule.activation.bulk_state,
        vip_state: hasOtherDiscountInputs
          ? ((String(fd.get("collection_spend_vip_state") ?? "any") || "any") as RuleState)
          : current.collection_spend_rule.activation.vip_state,
        first_state: hasOtherDiscountInputs
          ? ((String(fd.get("collection_spend_first_state") ?? "any") || "any") as RuleState)
          : current.collection_spend_rule.activation.first_state,
      },
    },
    hvac_rule: {
      enabled: false, // resolved below
      min_indoor_per_outdoor: toNum(
        fd.get("hvac_min_indoor_per_outdoor"),
        current.hvac_rule.min_indoor_per_outdoor,
      ),
      max_indoor_per_outdoor: toNum(
        fd.get("hvac_max_indoor_per_outdoor"),
        current.hvac_rule.max_indoor_per_outdoor,
      ),
      percent_off_hvac_products: toNum(
        fd.get("hvac_percent_off_hvac_products"),
        current.hvac_rule.percent_off_hvac_products,
      ),
      amount_off_outdoor_per_bundle: toNum(
        fd.get("hvac_amount_off_outdoor_per_bundle"),
        current.hvac_rule.amount_off_outdoor_per_bundle,
      ),
      indoor_product_ids: hvacIndoorProductIds,
      outdoor_product_ids: hvacOutdoorProductIds,
      combination_rules: hasHvacComboInputs
        ? hvacCombinationRules
        : current.hvac_rule.combination_rules ?? [],
    },
    cart_labels: {
      best_label: String(fd.get("cart_label_best") ?? current.cart_labels.best_label ?? "Best").trim() || "Best",
      other_label:
        String(fd.get("cart_label_other") ?? current.cart_labels.other_label ?? "Other discount").trim() ||
        "Other discount",
      hvac_exclusive_label:
        String(
          fd.get("cart_label_hvac_exclusive") ??
            current.cart_labels.hvac_exclusive_label ??
            "HVAC exclusive",
        ).trim() || "HVAC exclusive",
      hvac_stack_label:
        String(fd.get("cart_label_hvac_stack") ?? current.cart_labels.hvac_stack_label ?? "HVAC + base").trim() ||
        "HVAC + base",
    },
    auto_tagging: current.auto_tagging ?? DEFAULT_CONFIG.auto_tagging,
    block_if_any_entered_discount_code: false,
  };

  const topOtherEnabled = toBool(
    fd.get("toggle_collection_spend_enabled"),
    current.toggles.collection_spend_enabled,
  );
  const innerOtherEnabled = hasOtherDiscountInputs
    ? toBool(fd.get("collection_spend_enabled"), current.collection_spend_rule.enabled)
    : current.collection_spend_rule.enabled;
  const resolvedOtherEnabled = topOtherEnabled || innerOtherEnabled;
  config.toggles.collection_spend_enabled = resolvedOtherEnabled;
  config.collection_spend_rule.enabled = resolvedOtherEnabled;
  const topHvacEnabled = fd.has("toggle_hvac_enabled");
  config.toggles.hvac_enabled = topHvacEnabled;
  config.hvac_rule.enabled =
    topHvacEnabled || hvacCombinationRules.some((r) => Boolean(r?.enabled));

  const runtimePreview = buildRuntimeFunctionConfig(config);
  const runtimeItemRuleCount = runtimePreview.item_collection_rules.length;
  const runtimeItemProductCount = runtimePreview.item_collection_rules.reduce(
    (sum, rule) => sum + (Array.isArray(rule.product_ids) ? rule.product_ids.length : 0),
    0,
  );
  const runtimeOtherProductCount = Array.isArray(runtimePreview.collection_spend_rule?.product_ids)
    ? runtimePreview.collection_spend_rule.product_ids.length
    : 0;
  const runtimeBytes = Buffer.byteLength(JSON.stringify(runtimePreview), "utf8");
  const zeroResolvedItemRules = (config.item_collection_rules ?? []).filter(
    (rule) =>
      String(rule?.collection_id ?? "").trim() &&
      Number(rule?.percent ?? 0) > 0 &&
      (!Array.isArray(rule?.product_ids) || rule.product_ids.length === 0),
  );
  const resolutionWarnings: Array<{ field: string[]; message: string }> = [];
  if (
    config.toggles.item_collection_enabled &&
    zeroResolvedItemRules.length > 0
  ) {
    const zeroResolvedCollectionIds = zeroResolvedItemRules
      .map((rule) => String(rule?.collection_id ?? "").trim())
      .filter(Boolean);
    const sample = zeroResolvedCollectionIds.slice(0, 3).join(", ");
    resolutionWarnings.push({
      field: ["item_collection_rules"],
      message: `Item Rules resolved 0 products for ${zeroResolvedItemRules.length} selected collection(s)${
        sample ? ` (${sample}${zeroResolvedCollectionIds.length > 3 ? ", ..." : ""})` : ""
      }. Verify those collections contain products and the app has product read access.`,
    });
  }
  if (
    config.collection_spend_rule.enabled &&
    String(config.collection_spend_rule.collection_id ?? "").trim() &&
    runtimeOtherProductCount === 0
  ) {
    resolutionWarnings.push({
      field: ["collection_spend_rule", "collection_id"],
      message:
        "Other Discounts selected collection resolved 0 products. Verify the collection contains products and app product access is active.",
    });
  }
  const runtimeOwnerIds = deriveRuntimeOwnerIds(
    currentMeta.discountOwnerId,
    currentMeta.discountId,
    currentMeta.nodeId,
    configOwnerId,
  );
  console.info(
    `[discount-save-runtime] owner=${configOwnerId} nodeId=${String(
      currentMeta.nodeId ?? "",
    ).trim()} discountType=${String(currentMeta.discountType ?? "").trim()} discountId=${String(
      currentMeta.discountId ?? "",
    ).trim()} runtimeOwners=${runtimeOwnerIds.join(",")} itemRules=${runtimeItemRuleCount} itemProducts=${runtimeItemProductCount} otherEnabled=${config.collection_spend_rule.enabled} otherProducts=${runtimeOtherProductCount} runtimeBytes=${runtimeBytes} runtimeChunked=${runtimeBytes > FUNCTION_CONFIG_MAX_BYTES}`,
  );
  const json = await persistConfig(admin, configOwnerId, config, {
    shopOwnerId: shopMeta.shopId,
    runtimeOwnerIds,
  });
  const allErrors = [
    ...(json?.data?.metafieldsSet?.userErrors ?? []),
    ...resolutionWarnings,
  ];
  if (allErrors.length > 0) {
    console.warn(
      `[discount-save-runtime-warning] ${allErrors
        .map((e) => String(e?.message ?? "Unknown error"))
        .join(" | ")}`,
    );
  }
  return {
    ok: allErrors.length === 0,
    errors: allErrors,
    conflicts: detectConflicts(config),
  };
};

export default function DiscountDetailsRoute() {
  const {
    id,
    config,
    collections,
    conflicts,
    hvacOutdoorOptions,
    hvacIndoorOptions,
    outdoorCatalogConstraints,
    activeAutoTagJob,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const autoTagJobFetcher = useFetcher<typeof action>();
  const navigation = useNavigation();
  const isSaving = navigation.state === "submitting";
  const [tab, setTab] = useState<"order" | "item" | "otherDiscounts" | "autoTags" | "review">("order");
  const [activationMode, setActivationMode] = useState<ActivationMode>(
    config.collection_spend_rule.activation.mode,
  );
  const [rules, setRules] = useState(
    config.item_collection_rules.length ? config.item_collection_rules : DEFAULT_CONFIG.item_collection_rules,
  );
  const [hvacComboRules, setHvacComboRules] = useState<HvacCombinationRule[]>(
    withRuleUiIds(config.hvac_rule.combination_rules ?? []),
  );
  const [editingHvacRuleId, setEditingHvacRuleId] = useState<string | null>(null);
  const [autoTagJob, setAutoTagJob] = useState<AutoTagJobStatus | null>(
    (activeAutoTagJob as AutoTagJobStatus | null) ?? null,
  );
  const autoTagPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoTagFetcherStateRef = useRef(autoTagJobFetcher.state);
  const autoTagSubmitRef = useRef(autoTagJobFetcher.submit);
  const mergeIncomingAutoTagJob = (incoming: AutoTagJobStatus | null | undefined) => {
    if (!incoming?.id) return;
    setAutoTagJob((previous) => {
      if (!previous) return incoming;
      if (previous.status === "running" && incoming.id !== previous.id) return previous;
      if (previous.id !== incoming.id) return incoming;
      const previousUpdatedMs = Date.parse(String(previous.updatedAt ?? ""));
      const incomingUpdatedMs = Date.parse(String(incoming.updatedAt ?? ""));
      if (
        Number.isFinite(previousUpdatedMs) &&
        Number.isFinite(incomingUpdatedMs) &&
        incomingUpdatedMs < previousUpdatedMs
      ) {
        return previous;
      }
      // Never regress from a terminal state to running due to stale responses.
      if (previous.status !== "running" && incoming.status === "running") return previous;
      return {
        ...incoming,
        totalCount: Math.max(previous.totalCount, incoming.totalCount),
        processedCount: Math.max(previous.processedCount, incoming.processedCount),
        changedCount: Math.max(previous.changedCount, incoming.changedCount),
        skippedProtectedCount: Math.max(
          previous.skippedProtectedCount,
          incoming.skippedProtectedCount,
        ),
        errorCount: Math.max(previous.errorCount, incoming.errorCount),
      };
    });
  };
  useEffect(() => {
    const nextTab = String((actionData as any)?.activeTab ?? "");
    if (nextTab === "autoTags") setTab("autoTags");
  }, [actionData]);
  useEffect(() => {
    mergeIncomingAutoTagJob((activeAutoTagJob as AutoTagJobStatus | null) ?? null);
  }, [activeAutoTagJob]);
  useEffect(() => {
    const actionJob = (actionData as any)?.autoTagJob as AutoTagJobStatus | undefined;
    mergeIncomingAutoTagJob(actionJob);
  }, [actionData]);
  useEffect(() => {
    const fetcherJob = (autoTagJobFetcher.data as any)?.autoTagJob as AutoTagJobStatus | undefined;
    mergeIncomingAutoTagJob(fetcherJob);
  }, [autoTagJobFetcher.data]);
  useEffect(() => {
    autoTagFetcherStateRef.current = autoTagJobFetcher.state;
  }, [autoTagJobFetcher.state]);
  useEffect(() => {
    autoTagSubmitRef.current = autoTagJobFetcher.submit;
  }, [autoTagJobFetcher.submit]);
  useEffect(() => {
    if (autoTagPollTimerRef.current) {
      clearTimeout(autoTagPollTimerRef.current);
      autoTagPollTimerRef.current = null;
    }
    if (!autoTagJob?.id || autoTagJob.status !== "running") return;
    const runPoll = () => {
      if (autoTagFetcherStateRef.current === "idle") {
        const fd = new FormData();
        fd.set("intent", "auto_tag_job_poll");
        fd.set("auto_tag_job_id", autoTagJob.id);
        autoTagSubmitRef.current(fd, { method: "post" });
      }
      autoTagPollTimerRef.current = setTimeout(runPoll, 2500);
    };
    runPoll();
    return () => {
      if (autoTagPollTimerRef.current) {
        clearTimeout(autoTagPollTimerRef.current);
        autoTagPollTimerRef.current = null;
      }
    };
  }, [autoTagJob?.id, autoTagJob?.status]);
  const cardStyle: CSSProperties = {
    border: "1px solid rgba(17,24,39,0.12)",
    borderRadius: 12,
    padding: 12,
    background: "linear-gradient(180deg,#fff,#f8fafc)",
  };
  const labelStyle: CSSProperties = {
    display: "grid",
    gap: 6,
    fontSize: 12,
    color: "#334155",
    fontWeight: 600,
  };
  const inputStyle: CSSProperties = {
    width: "100%",
    minWidth: 0,
    boxSizing: "border-box",
    border: "1px solid rgba(17,24,39,0.18)",
    borderRadius: 8,
    padding: "8px 10px",
    fontSize: 14,
    background: "#fff",
  };
  const metricCardStyle: CSSProperties = {
    border: "1px solid rgba(17,24,39,0.12)",
    borderRadius: 10,
    padding: 10,
    background: "linear-gradient(180deg,#ffffff,#f8fafc)",
    display: "grid",
    gap: 6,
  };
  const [previewSubtotal, setPreviewSubtotal] = useState<number>(
    Math.max(0, Number(config.bulk10_min || config.bulk5_min || 0)),
  );
  const [previewOtherEligibleQty, setPreviewOtherEligibleQty] = useState<number>(
    Math.max(1, Number(config.collection_spend_rule.min_collection_qty || 1)),
  );
  const [previewOtherUnitPrice, setPreviewOtherUnitPrice] = useState<number>(
    Math.max(0, Number(config.collection_spend_rule.amount_off_per_step || 0)),
  );
  const previewBulkPercent = config.toggles.bulk_enabled
    ? bulkPercentForSubtotal(Math.max(0, previewSubtotal), config)
    : 0;
  const previewOtherUnits =
    config.toggles.collection_spend_enabled && config.collection_spend_rule.enabled
      ? Math.max(
          0,
          Math.min(
            Math.floor(
              Math.max(0, previewSubtotal) /
                Math.max(0.01, Number(config.collection_spend_rule.spend_step_amount || 0.01)),
            ),
            Math.floor(Math.max(0, previewOtherEligibleQty)),
            Number(config.collection_spend_rule.max_discounted_units_per_order || 0) > 0
              ? Math.floor(
                  Math.max(0, Number(config.collection_spend_rule.max_discounted_units_per_order || 0)),
                )
              : Number.MAX_SAFE_INTEGER,
          ),
        )
      : 0;
  const previewOtherPerUnit = Math.max(
    0,
    Math.min(
      Number(config.collection_spend_rule.amount_off_per_step || 0),
      Math.max(0, previewOtherUnitPrice),
    ),
  );
  const previewOtherTotal = previewOtherUnits * previewOtherPerUnit;
  const hvacDisplayOrder = hvacComboRules
    .map((_, idx) => idx)
    .sort((a, b) => Number(hvacComboRules[b]?.enabled) - Number(hvacComboRules[a]?.enabled) || a - b);
  const itemRulesForSubmit = rules.map((rule) => ({
    collection_id: String(rule?.collection_id ?? "").trim(),
    percent: Number(rule?.percent ?? 0),
  }));
  const hvacComboRulesForSubmit = hvacComboRules.map((rule) => ({
    name: String(rule?.name ?? "").trim(),
    enabled: Boolean(rule?.enabled),
    combo_brand: String(rule?.combo_brand ?? "").trim(),
    outdoor_source_sku: String(rule?.outdoor_source_sku ?? "").trim(),
    min_indoor_per_outdoor: Number(rule?.min_indoor_per_outdoor ?? 2),
    max_indoor_per_outdoor: Number(rule?.max_indoor_per_outdoor ?? 6),
    indoor_mode: rule?.indoor_mode === "selected_types" ? "selected_types" : "all",
    selected_head_types: Array.isArray(rule?.selected_head_types)
      ? rule.selected_head_types.map((v) => normalizeHeadType(v)).filter(Boolean)
      : [],
    indoor_series_mode: rule?.indoor_series_mode === "selected_series" ? "selected_series" : "all",
    selected_series: Array.isArray(rule?.selected_series)
      ? rule.selected_series.map((v) => String(v ?? "").trim()).filter(Boolean)
      : [],
    percent_off_hvac_products: Number(rule?.percent_off_hvac_products ?? 0),
    amount_off_outdoor_per_bundle: Number(rule?.amount_off_outdoor_per_bundle ?? 0),
    stack_mode: rule?.stack_mode === "exclusive_best" ? "exclusive_best" : "stackable",
  }));

  return (
    <s-page heading={`Smart Discount ${id}`}>
      <div style={{ maxWidth: 980, margin: "0 auto", display: "grid", gap: 14 }}>
        <div
          style={{
            padding: 18,
            borderRadius: 14,
            border: "1px solid rgba(17,24,39,0.12)",
            background:
              "linear-gradient(135deg, rgba(11,121,227,0.12), rgba(1,173,130,0.12) 45%, rgba(248,181,0,0.12))",
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 20 }}>Smart Discount Engine</div>
          <div style={{ marginTop: 6, opacity: 0.85 }}>
            Tabs, toggles, anti-stacking, and conflict checks all in one place.
          </div>
        </div>

        <form
          method="post"
          style={{
            background: "white",
            borderRadius: 14,
            border: "1px solid rgba(17,24,39,0.12)",
            overflow: "hidden",
          }}
        >
          <input type="hidden" name="item_rule_count" value={rules.length} />
          <input
            type="hidden"
            name="item_rules_json"
            value={encodeURIComponent(JSON.stringify(itemRulesForSubmit))}
          />
          <input type="hidden" name="hvac_combo_rule_count" value={hvacComboRules.length} />
          <input
            type="hidden"
            name="hvac_combo_rules_json"
            value={encodeURIComponent(JSON.stringify(hvacComboRulesForSubmit))}
          />

          {"ok" in (actionData ?? {}) ? (
            <div style={{ padding: 12, borderBottom: "1px solid rgba(17,24,39,0.1)" }}>
              {(actionData as any)?.ok ? (
                <s-banner tone="success">Settings saved.</s-banner>
              ) : (
                <s-banner tone="warning">
                  Save failed:{" "}
                  {Array.isArray((actionData as any)?.errors) && (actionData as any).errors.length
                    ? (actionData as any).errors.map((e: any) => String(e?.message ?? "Unknown error")).join(" | ")
                    : "Unknown error"}
                </s-banner>
              )}
            </div>
          ) : null}

          <div style={{ padding: 12, borderBottom: "1px solid rgba(17,24,39,0.1)", background: "#F8FAFC" }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>Enable / Disable</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              <label><input type="checkbox" name="toggle_first_order_enabled" value="1" defaultChecked={config.toggles.first_order_enabled} /> First</label>
              <label><input type="checkbox" name="toggle_bulk_enabled" value="1" defaultChecked={config.toggles.bulk_enabled} /> Bulk</label>
              <label><input type="checkbox" name="toggle_vip_enabled" value="1" defaultChecked={config.toggles.vip_enabled} /> VIP</label>
              <label><input type="checkbox" name="toggle_item_collection_enabled" value="1" defaultChecked={config.toggles.item_collection_enabled} /> Item Rules</label>
              <label><input type="checkbox" name="toggle_collection_spend_enabled" value="1" defaultChecked={config.toggles.collection_spend_enabled} /> Other Discounts</label>
              <label><input type="checkbox" name="toggle_hvac_enabled" value="1" defaultChecked={config.toggles.hvac_enabled} /> HVAC Bundles</label>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, padding: 12, borderBottom: "1px solid rgba(17,24,39,0.1)" }}>
            <button type="button" onClick={() => setTab("order")} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid rgba(17,24,39,0.18)", background: tab === "order" ? "#0B79E3" : "white", color: tab === "order" ? "white" : "#111827" }}>Order Rules</button>
            <button type="button" onClick={() => setTab("item")} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid rgba(17,24,39,0.18)", background: tab === "item" ? "#01AD82" : "white", color: tab === "item" ? "white" : "#111827" }}>Item Rules</button>
            <button type="button" onClick={() => setTab("otherDiscounts")} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid rgba(17,24,39,0.18)", background: tab === "otherDiscounts" ? "#7C3AED" : "white", color: tab === "otherDiscounts" ? "white" : "#111827" }}>Other Discounts</button>
            <button type="button" onClick={() => setTab("autoTags")} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid rgba(17,24,39,0.18)", background: tab === "autoTags" ? "#0EA5A4" : "white", color: tab === "autoTags" ? "white" : "#111827" }}>Automatic Collection Tags</button>
            <button type="button" onClick={() => setTab("review")} style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid rgba(17,24,39,0.18)", background: tab === "review" ? "#F59E0B" : "white", color: tab === "review" ? "white" : "#111827" }}>Review</button>
          </div>

          <div style={{ padding: 16, display: "grid", gap: 12 }}>
            {tab === "order" ? (
              <div style={{ display: "grid", gap: 12 }}>
                <div style={cardStyle}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>How Order Rules Work</div>
                  <div style={{ marginTop: 4, fontSize: 13, color: "#475569" }}>
                    The engine picks the single highest eligible order-level discount (First vs Bulk vs VIP). It does not stack these tiers.
                  </div>
                </div>

                <div style={cardStyle}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>First-Time Buyer Rule</div>
                  <div style={{ marginTop: 4, fontSize: 13, color: "#475569" }}>
                    Applies when customer has zero prior orders.
                  </div>
                  <div style={{ marginTop: 10, maxWidth: 260 }}>
                    <label style={labelStyle}>
                      First order discount (%)
                      <input
                        style={inputStyle}
                        name="first_order_percent"
                        type="number"
                        step="0.01"
                        defaultValue={config.first_order_percent}
                      />
                    </label>
                  </div>
                </div>

                <div style={cardStyle}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>Bulk Tier Rules</div>
                  <div style={{ marginTop: 4, fontSize: 13, color: "#475569" }}>
                    For each tier, set the minimum subtotal and the discount percent. Highest matched tier wins.
                  </div>
                  <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                    <div style={{ display: "grid", gap: 10, gridTemplateColumns: "2fr 1fr" }}>
                      <label style={labelStyle}>
                        BULK5 trigger subtotal (at least)
                        <input style={inputStyle} name="bulk5_min" type="number" step="0.01" defaultValue={config.bulk5_min} />
                      </label>
                      <label style={labelStyle}>
                        BULK5 discount (%)
                        <input style={inputStyle} name="bulk5_percent" type="number" step="0.01" defaultValue={config.bulk5_percent} />
                      </label>
                    </div>
                    <div style={{ display: "grid", gap: 10, gridTemplateColumns: "2fr 1fr" }}>
                      <label style={labelStyle}>
                        BULK10 trigger subtotal (at least)
                        <input style={inputStyle} name="bulk10_min" type="number" step="0.01" defaultValue={config.bulk10_min} />
                      </label>
                      <label style={labelStyle}>
                        BULK10 discount (%)
                        <input style={inputStyle} name="bulk10_percent" type="number" step="0.01" defaultValue={config.bulk10_percent} />
                      </label>
                    </div>
                    <div style={{ display: "grid", gap: 10, gridTemplateColumns: "2fr 1fr" }}>
                      <label style={labelStyle}>
                        BULK13 trigger subtotal (at least)
                        <input style={inputStyle} name="bulk13_min" type="number" step="0.01" defaultValue={config.bulk13_min} />
                      </label>
                      <label style={labelStyle}>
                        BULK13 discount (%)
                        <input style={inputStyle} name="bulk13_percent" type="number" step="0.01" defaultValue={config.bulk13_percent} />
                      </label>
                    </div>
                    <div style={{ display: "grid", gap: 10, gridTemplateColumns: "2fr 1fr" }}>
                      <label style={labelStyle}>
                        BULK15 trigger subtotal (at least)
                        <input style={inputStyle} name="bulk15_min" type="number" step="0.01" defaultValue={config.bulk15_min} />
                      </label>
                      <label style={labelStyle}>
                        BULK15 discount (%)
                        <input style={inputStyle} name="bulk15_percent" type="number" step="0.01" defaultValue={config.bulk15_percent} />
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {tab === "item" ? <div style={{ display: "grid", gap: 10 }}>
              {rules.map((rule, i) => <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 160px 120px", gap: 8, alignItems: "center", padding: 10, border: "1px solid rgba(17,24,39,0.12)", borderRadius: 10, background: "rgba(1,173,130,0.04)" }}>
                <select
                  name={`item_rule_collection_${i}`}
                  value={rule.collection_id}
                  onChange={(e) => {
                    const nextValue = e.currentTarget.value;
                    setRules((prev) =>
                      prev.map((r, idx) =>
                        idx === i ? { ...r, collection_id: nextValue } : r,
                      ),
                    );
                  }}
                >
                  <option value="">Select collection</option>
                  {collections.map((c: CollectionOption) => <option key={c.id} value={c.id}>{c.title}</option>)}
                </select>
                <input
                  name={`item_rule_percent_${i}`}
                  type="number"
                  step="0.01"
                  value={rule.percent}
                  onChange={(e) => {
                    const nextPercent = Number(e.currentTarget.value || "0");
                    setRules((prev) =>
                      prev.map((r, idx) =>
                        idx === i ? { ...r, percent: nextPercent } : r,
                      ),
                    );
                  }}
                />
                <button type="button" onClick={() => setRules((prev) => prev.filter((_, idx) => idx !== i))}>Remove</button>
              </div>)}
              <button type="button" onClick={() => setRules((prev) => [...prev, { collection_id: "", percent: 0, product_ids: [] }])}>Add rule</button>
            </div> : null}

            {tab === "otherDiscounts" ? <div style={{ display: "grid", gap: 10 }}>
              <div style={cardStyle}>
                <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>
                  $X off item(s) from Y collection for every $Z spent
                </div>
                <div style={{ marginTop: 4, fontSize: 13, color: "#475569" }}>
                  Read as: for products in collection Y, discount each qualifying item by $X for every $Z spent in that same collection.
                </div>
              </div>

              <label><input type="checkbox" name="collection_spend_enabled" value="1" defaultChecked={config.collection_spend_rule.enabled} /> Enable this rule</label>
              <select name="collection_spend_collection_id" defaultValue={config.collection_spend_rule.collection_id}>
                <option value="">Select collection</option>
                {collections.map((c: CollectionOption) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
                <label style={labelStyle}>
                  X: Amount off each eligible item ($)
                  <input style={inputStyle} name="collection_spend_amount_off" type="number" step="0.01" defaultValue={config.collection_spend_rule.amount_off_per_step} />
                </label>
                <label style={labelStyle}>
                  Y: Minimum item quantity from selected collection
                  <input style={inputStyle} name="collection_spend_min_qty" type="number" step="1" defaultValue={config.collection_spend_rule.min_collection_qty} />
                </label>
                <label style={labelStyle}>
                  Z: Cart subtotal step ($)
                  <input style={inputStyle} name="collection_spend_step_amount" type="number" step="0.01" defaultValue={config.collection_spend_rule.spend_step_amount} />
                </label>
                <label style={labelStyle}>
                  Max discounted units per order (0 = no cap)
                  <input
                    style={inputStyle}
                    name="collection_spend_max_units_per_order"
                    type="number"
                    min="0"
                    step="1"
                    defaultValue={config.collection_spend_rule.max_discounted_units_per_order}
                  />
                </label>
              </div>
              <label style={labelStyle}>
                Activation behavior
                <select
                  style={inputStyle}
                  name="collection_spend_activation_mode"
                  value={activationMode}
                  onChange={(e) => setActivationMode(e.currentTarget.value as ActivationMode)}
                >
                  <option value="always">Always apply when X/Y/Z rule is eligible</option>
                  <option value="no_other_discounts">Only when no other discount code is present</option>
                  <option value="requires_any_xyz_active">Only when one of these is active: Bulk, VIP, First</option>
                  <option value="requires_xyz_state">Advanced: require specific active/inactive states</option>
                </select>
              </label>

              {activationMode === "requires_any_xyz_active" ? (
                <div style={{ ...cardStyle, display: "grid", gap: 8 }}>
                  <div style={{ fontWeight: 600 }}>Choose at least one required active discount type</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                    <label><input type="checkbox" name="collection_spend_required_bulk" value="1" defaultChecked={config.collection_spend_rule.activation.required_any.includes("bulk")} /> Bulk must be active</label>
                    <label><input type="checkbox" name="collection_spend_required_vip" value="1" defaultChecked={config.collection_spend_rule.activation.required_any.includes("vip")} /> VIP must be active</label>
                    <label><input type="checkbox" name="collection_spend_required_first" value="1" defaultChecked={config.collection_spend_rule.activation.required_any.includes("first")} /> First-order must be active</label>
                  </div>
                </div>
              ) : null}

              {activationMode === "requires_xyz_state" ? (
                <div style={{ ...cardStyle, display: "grid", gap: 10 }}>
                  <div style={{ fontWeight: 600 }}>Advanced state matching</div>
                  <div style={{ fontSize: 13, color: "#475569" }}>
                    Set each discount type to Active, Inactive, or Ignore. Use AND/OR to combine.
                  </div>
                  <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
                    <select style={inputStyle} name="collection_spend_xyz_operator" defaultValue={config.collection_spend_rule.activation.xyz_operator}><option value="or">OR (any selected condition can match)</option><option value="and">AND (all selected conditions must match)</option></select>
                    <select style={inputStyle} name="collection_spend_bulk_state" defaultValue={config.collection_spend_rule.activation.bulk_state}><option value="any">Bulk: Ignore</option><option value="active">Bulk: Must be active</option><option value="inactive">Bulk: Must be inactive</option></select>
                    <select style={inputStyle} name="collection_spend_vip_state" defaultValue={config.collection_spend_rule.activation.vip_state}><option value="any">VIP: Ignore</option><option value="active">VIP: Must be active</option><option value="inactive">VIP: Must be inactive</option></select>
                    <select style={inputStyle} name="collection_spend_first_state" defaultValue={config.collection_spend_rule.activation.first_state}><option value="any">First-order: Ignore</option><option value="active">First-order: Must be active</option><option value="inactive">First-order: Must be inactive</option></select>
                  </div>
                </div>
              ) : null}

              <div style={{ ...cardStyle, borderColor: "rgba(11,121,227,0.28)" }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>HVAC Specific Combination Rules</div>
                <div style={{ marginTop: 4, fontSize: 13, color: "#475569" }}>
                  Uses mapped products from{" "}
                  <a href="/app/hvac-mapping">HVAC Mapping</a>. Configure discounts per outdoor combination only.
                </div>
                <div style={{ marginTop: 14, borderTop: "1px solid rgba(17,24,39,0.12)", paddingTop: 12 }}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>Specific Combination Rules</div>
                  <div style={{ fontSize: 12, color: "#475569", marginBottom: 10 }}>
                    Configure per-outdoor combination behavior. Each rule can have its own discount type and stacking mode.
                  </div>
                  <div style={{ display: "grid", gap: 10 }}>
                    {hvacDisplayOrder.map((i) => {
                      const rule = hvacComboRules[i];
                      const ruleUiId = rule.__ui_id || String(i);
                      const isEditing = editingHvacRuleId === ruleUiId;
                      const selectedBrand = String(rule.combo_brand || "").trim();
                      const selectedOutdoorSku = String(rule.outdoor_source_sku || "").trim();
                      const outdoorMeta = hvacOutdoorOptions.find(
                        (opt: any) => String(opt?.sourceSku ?? "").trim() === selectedOutdoorSku,
                      );
                      const selectedOutdoorFallback =
                        selectedOutdoorSku &&
                        !hvacOutdoorOptions.some(
                          (opt: any) => String(opt?.sourceSku ?? "").trim() === selectedOutdoorSku,
                        )
                          ? [
                              {
                                sourceSku: selectedOutdoorSku,
                                mappedProductId: null,
                                mappedProductTitle: null,
                                sourceBrand: selectedBrand || null,
                                sourceSeries: null,
                                sourceSystem: null,
                                sourceRefrigerant: null,
                                sourceBtu: null,
                              },
                            ]
                          : [];
                      const outdoorOptionsWithFallback = [
                        ...hvacOutdoorOptions,
                        ...selectedOutdoorFallback,
                      ];
                      const availableBrands = Array.from(
                        new Set(
                          outdoorOptionsWithFallback
                            .map((o: any) => String(o?.sourceBrand ?? "").trim())
                            .concat(selectedBrand ? [selectedBrand] : [])
                            .filter(Boolean),
                        ),
                      ).sort((a, b) => a.localeCompare(b));
                      const outdoorOptionsForBrand = selectedBrand
                        ? outdoorOptionsWithFallback.filter(
                            (o: any) => String(o?.sourceBrand ?? "").trim() === selectedBrand,
                          )
                        : outdoorOptionsWithFallback;
                      const constraint = outdoorCatalogConstraints[rule.outdoor_source_sku];
                      const brand = String(selectedBrand || outdoorMeta?.sourceBrand || "").trim();
                      const outdoorRefrigerant = String(outdoorMeta?.sourceRefrigerant ?? "").trim();
                      const allowedIndoorSourceSkuSet = new Set(
                        Array.isArray(constraint?.allowedIndoorSourceSkus)
                          ? constraint.allowedIndoorSourceSkus
                              .map((sku: any) => String(sku ?? "").trim().toUpperCase())
                              .filter(Boolean)
                          : [],
                      );
                      const filteredIndoor = hvacIndoorOptions.filter((opt: any) => {
                        const indoorSourceSku = String(opt?.sourceSku ?? "").trim();
                        const allowedOk =
                          allowedIndoorSourceSkuSet.size === 0 ||
                          allowedIndoorSourceSkuSet.has(indoorSourceSku.toUpperCase());
                        const indoorBrand = String(opt?.sourceBrand ?? "").trim();
                        const indoorRefrigerant = String(opt?.sourceRefrigerant ?? "").trim();
                        const brandOk = Boolean(brand) && Boolean(indoorBrand) && norm(indoorBrand) === norm(brand);
                        const refrigerantOk =
                          Boolean(outdoorRefrigerant) &&
                          Boolean(indoorRefrigerant) &&
                          norm(indoorRefrigerant) === norm(outdoorRefrigerant);
                        return allowedOk && brandOk && refrigerantOk;
                      });
                      const availableHeadTypes = Array.from(
                        new Set(filteredIndoor.map((opt: any) => inferIndoorHeadType(opt)).filter(Boolean)),
                      );
                      const availableSeries = Array.from(
                        new Set(
                          filteredIndoor
                            .map((opt: any) => String(opt?.sourceSeries ?? "").trim())
                            .filter(Boolean),
                        ),
                      ).sort((a, b) => a.localeCompare(b));
                      return (
                      <div
                        key={ruleUiId}
                        style={{
                          border: "1px solid rgba(17,24,39,0.12)",
                          borderRadius: 10,
                          padding: 10,
                          background: "#fff",
                          display: "grid",
                          gap: 8,
                        }}
                      >
                        <input type="hidden" name={`hvac_combo_name_${i}`} value={rule.name} />
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                          <label>
                            <input
                              type="checkbox"
                              name={`hvac_combo_enabled_${i}`}
                              value="1"
                              checked={rule.enabled}
                              onChange={(e) =>
                                {
                                  const checked = e.currentTarget.checked;
                                  setHvacComboRules((prev) =>
                                  prev.map((r, idx) =>
                                    idx === i ? { ...r, enabled: checked } : r,
                                  ),
                                  );
                                }
                              }
                            />{" "}
                            Enable rule
                          </label>
                          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                            <div style={{ fontSize: 12, color: "#475569" }}>
                              {rule.outdoor_source_sku || "Select outdoor"} | {rule.percent_off_hvac_products}% | ${rule.amount_off_outdoor_per_bundle} off outdoor
                            </div>
                            <button
                              type="button"
                              onClick={() =>
                                setEditingHvacRuleId((prev) => (prev === ruleUiId ? null : ruleUiId))
                              }
                            >
                              {isEditing ? "Close" : "Quick edit"}
                            </button>
                          <button
                            type="button"
                            onClick={() => {
                              setHvacComboRules((prev) => prev.filter((_, idx) => idx !== i));
                              setEditingHvacRuleId((prev) => (prev === ruleUiId ? null : prev));
                            }}
                          >
                            Remove
                          </button>
                          </div>
                        </div>
                        <div style={{ display: isEditing ? "grid" : "none", gap: 8 }}>
                        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
                          <label style={labelStyle}>
                            Brand
                            <select
                              style={inputStyle}
                              name={`hvac_combo_brand_${i}`}
                              value={rule.combo_brand}
                              onChange={(e) => {
                                const v = e.currentTarget.value;
                                setHvacComboRules((prev) =>
                                  prev.map((r, idx) => {
                                    if (idx !== i) return r;
                                    const sameOutdoor =
                                      !r.outdoor_source_sku ||
                                      hvacOutdoorOptions.some(
                                        (o: any) =>
                                          o.sourceSku === r.outdoor_source_sku &&
                                          String(o?.sourceBrand ?? "").trim() === v,
                                      );
                                    return {
                                      ...r,
                                      combo_brand: v,
                                      outdoor_source_sku: sameOutdoor ? r.outdoor_source_sku : "",
                                    };
                                  }),
                                );
                              }}
                            >
                              <option value="">All brands</option>
                              {availableBrands.map((b) => (
                                <option key={b} value={b}>
                                  {b}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label style={labelStyle}>
                            Outdoor SKU
                            <select
                              style={inputStyle}
                              name={`hvac_combo_outdoor_sku_${i}`}
                              value={rule.outdoor_source_sku}
                              onChange={(e) =>
                                {
                                  const nextValue = e.currentTarget.value;
                                  setHvacComboRules((prev) =>
                                  prev.map((r, idx) =>
                                    idx === i ? { ...r, outdoor_source_sku: nextValue } : r,
                                  ),
                                  );
                                }
                              }
                            >
                              <option value="">Select mapped outdoor SKU</option>
                              {outdoorOptionsForBrand.map((opt: any) => (
                                <option key={`${opt.sourceSku}:${opt.mappedProductId}`} value={opt.sourceSku}>
                                  {opt.sourceSku}
                                  {constraint?.tierLabels?.length
                                    ? ` - ${constraint.tierLabels.join("/")}`
                                    : opt.sourceSystem
                                      ? ` - ${opt.sourceSystem}`
                                      : ""}
                                  {displayBtu(opt.sourceBtu) != null ? ` - ${displayBtu(opt.sourceBtu)} BTU` : ""}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label style={labelStyle}>
                            Heads allowed for this condenser
                            <input
                              style={inputStyle}
                              readOnly
                              value={
                                constraint
                                  ? `${constraint.minHeads} to ${constraint.maxHeads} heads`
                                  : "2 to 6 heads (default)"
                              }
                            />
                          </label>
                          <label style={labelStyle}>
                            Indoor head type mode
                            <select
                              style={inputStyle}
                              name={`hvac_combo_indoor_mode_${i}`}
                              value={rule.indoor_mode}
                              onChange={(e) => {
                                const v =
                                  e.currentTarget.value === "selected_types" ? "selected_types" : "all";
                                setHvacComboRules((prev) =>
                                  prev.map((r, idx) =>
                                    idx === i ? { ...r, indoor_mode: v } : r,
                                  ),
                                );
                              }}
                            >
                              <option value="all">All allowed head types</option>
                              <option value="selected_types">Only selected head types</option>
                            </select>
                          </label>
                          <label style={labelStyle}>
                            Stack mode
                            <select
                              style={inputStyle}
                              name={`hvac_combo_stack_mode_${i}`}
                              value={rule.stack_mode}
                              onChange={(e) =>
                                {
                                  const nextValue = e.currentTarget.value;
                                  setHvacComboRules((prev) =>
                                  prev.map((r, idx) =>
                                    idx === i
                                      ? {
                                          ...r,
                                          stack_mode: nextValue === "exclusive_best" ? "exclusive_best" : "stackable",
                                        }
                                      : r,
                                  ),
                                  );
                                }
                              }
                            >
                              <option value="stackable">Stackable</option>
                              <option value="exclusive_best">Exclusive best</option>
                            </select>
                          </label>
                        </div>

                        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
                          <div style={metricCardStyle}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: "#334155" }}>% Off Discount</div>
                            <label style={labelStyle}>
                              Percent off eligible HVAC items
                              <div style={{ display: "grid", gridTemplateColumns: "40px 1fr", alignItems: "center", gap: 8 }}>
                                <div style={{ textAlign: "center", fontWeight: 700, color: "#0B79E3" }}>%</div>
                                <input
                                  style={inputStyle}
                                  name={`hvac_combo_percent_${i}`}
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={rule.percent_off_hvac_products}
                                  onChange={(e) =>
                                    {
                                      const nextValue = Number(e.currentTarget.value || "0");
                                      setHvacComboRules((prev) =>
                                      prev.map((r, idx) =>
                                        idx === i
                                          ? { ...r, percent_off_hvac_products: nextValue }
                                          : r,
                                      ),
                                      );
                                    }
                                  }
                                />
                              </div>
                            </label>
                          </div>

                          <div style={metricCardStyle}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: "#334155" }}>$ Off Discount</div>
                            <label style={labelStyle}>
                              Dollar off each outdoor unit in bundle
                              <div style={{ display: "grid", gridTemplateColumns: "40px 1fr", alignItems: "center", gap: 8 }}>
                                <div style={{ textAlign: "center", fontWeight: 700, color: "#0B79E3" }}>$</div>
                                <input
                                  style={inputStyle}
                                  name={`hvac_combo_amount_${i}`}
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={rule.amount_off_outdoor_per_bundle}
                                  onChange={(e) =>
                                    {
                                      const nextValue = Number(e.currentTarget.value || "0");
                                      setHvacComboRules((prev) =>
                                      prev.map((r, idx) =>
                                        idx === i
                                          ? {
                                              ...r,
                                              amount_off_outdoor_per_bundle: nextValue,
                                            }
                                          : r,
                                      ),
                                      );
                                    }
                                  }
                                />
                              </div>
                            </label>
                          </div>
                        </div>
                        {rule.indoor_mode === "selected_types" ? (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                            {availableHeadTypes.map((type) => (
                              <label key={type} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                <input
                                  type="checkbox"
                                  name={`hvac_combo_head_type_${i}`}
                                  value={type}
                                  checked={rule.selected_head_types.includes(normalizeHeadType(type))}
                                  onChange={(e) => {
                                    const checked = e.currentTarget.checked;
                                    setHvacComboRules((prev) =>
                                      prev.map((r, idx) => {
                                        if (idx !== i) return r;
                                        const next = new Set(r.selected_head_types);
                                        const normalized = normalizeHeadType(type);
                                        if (checked) next.add(normalized);
                                        else next.delete(normalized);
                                        return { ...r, selected_head_types: Array.from(next) };
                                      }),
                                    );
                                  }}
                                />
                                {type}
                              </label>
                            ))}
                          </div>
                        ) : null}
                        <div style={{ display: "grid", gap: 8 }}>
                          <label style={labelStyle}>
                            Indoor series mode
                            <select
                              style={inputStyle}
                              name={`hvac_combo_indoor_series_mode_${i}`}
                              value={rule.indoor_series_mode}
                              onChange={(e) => {
                                const v =
                                  e.currentTarget.value === "selected_series" ? "selected_series" : "all";
                                setHvacComboRules((prev) =>
                                  prev.map((r, idx) =>
                                    idx === i ? { ...r, indoor_series_mode: v } : r,
                                  ),
                                );
                              }}
                            >
                              <option value="all">All series in this outdoor rule</option>
                              <option value="selected_series">Only selected series</option>
                            </select>
                          </label>
                          {rule.indoor_series_mode === "selected_series" ? (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                              {availableSeries.map((seriesName) => (
                                <label key={seriesName} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                  <input
                                    type="checkbox"
                                    name={`hvac_combo_series_${i}`}
                                    value={seriesName}
                                    checked={rule.selected_series.includes(seriesName)}
                                    onChange={(e) => {
                                      const checked = e.currentTarget.checked;
                                      setHvacComboRules((prev) =>
                                        prev.map((r, idx) => {
                                          if (idx !== i) return r;
                                          const next = new Set(r.selected_series);
                                          if (checked) next.add(seriesName);
                                          else next.delete(seriesName);
                                          return { ...r, selected_series: Array.from(next) };
                                        }),
                                      );
                                    }}
                                  />
                                  {seriesName}
                                </label>
                              ))}
                            </div>
                          ) : null}
                        </div>
                        <div style={{ fontSize: 12, color: "#475569" }}>
                          <div style={{ fontWeight: 600, marginBottom: 4 }}>Indoor options (filtered)</div>
                          <div style={{ maxHeight: 180, overflow: "auto", border: "1px solid rgba(17,24,39,0.12)", borderRadius: 8 }}>
                            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                              <thead>
                                <tr style={{ background: "#F8FAFC" }}>
                                  <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid rgba(17,24,39,0.12)" }}>
                                    Head Type
                                  </th>
                                  <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid rgba(17,24,39,0.12)" }}>
                                    SKU
                                  </th>
                                  <th style={{ textAlign: "left", padding: "6px 8px", borderBottom: "1px solid rgba(17,24,39,0.12)" }}>
                                    BTU
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {filteredIndoor.slice(0, 40).map((opt: any, idx: number) => (
                                  <tr key={`${opt.sourceSku}:${idx}`}>
                                    <td style={{ padding: "6px 8px", borderBottom: "1px solid rgba(17,24,39,0.08)" }}>
                                      {inferIndoorHeadType(opt)}
                                    </td>
                                    <td style={{ padding: "6px 8px", borderBottom: "1px solid rgba(17,24,39,0.08)" }}>
                                      <code>{opt.sourceSku}</code>
                                    </td>
                                    <td style={{ padding: "6px 8px", borderBottom: "1px solid rgba(17,24,39,0.08)" }}>
                                      {displayBtu(opt.sourceBtu) ?? "-"}
                                    </td>
                                  </tr>
                                ))}
                                {filteredIndoor.length === 0 ? (
                                  <tr>
                                    <td colSpan={3} style={{ padding: "8px", color: "#64748b" }}>
                                      No indoor options matched this outdoor brand/series filter.
                                    </td>
                                  </tr>
                                ) : null}
                              </tbody>
                            </table>
                          </div>
                        </div>
                        </div>
                      </div>
                    )})}
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <button
                      type="button"
                      onClick={() => {
                        const newRule: HvacCombinationRule = {
                          __ui_id: newRuleUiId(),
                          name: `Rule ${hvacComboRules.length + 1}`,
                          enabled: true,
                          combo_brand: "",
                          outdoor_source_sku: "",
                          min_indoor_per_outdoor: 2,
                          max_indoor_per_outdoor: 6,
                          indoor_mode: "all",
                          selected_head_types: [],
                          indoor_series_mode: "all",
                          selected_series: [],
                          indoor_product_ids: [],
                          percent_off_hvac_products: 0,
                          amount_off_outdoor_per_bundle: 0,
                          stack_mode: "stackable",
                          outdoor_product_ids: [],
                        };
                        setHvacComboRules((prev) => [...prev, newRule]);
                        setEditingHvacRuleId(newRule.__ui_id ?? null);
                      }}
                    >
                      Add combination rule
                    </button>
                  </div>
                </div>
              </div>
            </div> : null}

            {tab === "autoTags" ? (
              <div style={{ display: "grid", gap: 12 }}>
                <div style={cardStyle}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>
                    Automatic Collection Tags
                  </div>
                  <div style={{ marginTop: 4, fontSize: 13, color: "#475569" }}>
                    Enter one or more SKU tokens. SKU matching is case-insensitive, supports composite SKUs with
                    <code> + </code>, and ignores multipliers like <code>x3</code>/<code>3x</code>.
                  </div>
                </div>

                {(actionData as any)?.message ? (
                  <s-banner tone={(actionData as any)?.ok ? "success" : "warning"}>
                    {String((actionData as any).message)}
                  </s-banner>
                ) : null}
                {autoTagJob ? (
                  <div style={{ ...cardStyle, borderColor: "rgba(11,121,227,0.28)" }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>
                      Auto-tag job: {autoTagJob.status}
                    </div>
                    <div style={{ marginTop: 6, fontSize: 13, color: "#334155" }}>
                      {autoTagJob.processedCount}/{autoTagJob.totalCount} processed | changed{" "}
                      {autoTagJob.changedCount} | skipped HVAC {autoTagJob.skippedProtectedCount} | errors{" "}
                      {autoTagJob.errorCount}
                    </div>
                    <div
                      style={{
                        marginTop: 8,
                        height: 10,
                        borderRadius: 999,
                        background: "rgba(15,23,42,0.12)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${
                            autoTagJob.totalCount > 0
                              ? Math.max(0, Math.min(100, (autoTagJob.processedCount / autoTagJob.totalCount) * 100))
                              : autoTagJob.status === "running"
                                ? 0
                                : 100
                          }%`,
                          background:
                            autoTagJob.status === "completed"
                              ? "#10B981"
                              : autoTagJob.status === "failed"
                                ? "#EF4444"
                                : "#0B79E3",
                          transition: "width 200ms ease",
                        }}
                      />
                    </div>
                    <div style={{ marginTop: 6, fontSize: 12, color: "#64748b" }}>
                      Started {new Date(autoTagJob.createdAt).toLocaleString()}
                      {autoTagJob.status === "running" ? " (running in background)" : ""}
                    </div>
                  </div>
                ) : null}

                <div style={{ ...cardStyle, display: "grid", gap: 10 }}>
                  <div style={{ display: "grid", gap: 10, gridTemplateColumns: "2fr 1fr" }}>
                    <label style={labelStyle}>
                      SKU(s) to match
                      <textarea
                        style={{ ...inputStyle, minHeight: 84, resize: "vertical" }}
                        name="auto_tag_skus"
                        placeholder="Example: BRV-M24-230VO, CH-R48MES-230VO+CH-R09MOLVWM-230VI"
                        defaultValue=""
                      />
                    </label>
                    <label style={labelStyle}>
                      Action
                      <select style={inputStyle} name="auto_tag_mode" defaultValue="tag">
                        <option value="tag">Tag matched listings</option>
                        <option value="untag_discount">Remove discount tags (e.g. X off)</option>
                      </select>
                    </label>
                  </div>

                  <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
                    <label style={labelStyle}>
                      Tag to apply (for Tag mode)
                      <input
                        style={inputStyle}
                        name="auto_tag_target_tag"
                        placeholder="acc"
                        defaultValue=""
                      />
                    </label>
                    <label style={labelStyle}>
                      Schedule undo at (optional)
                      <input
                        style={inputStyle}
                        name="auto_tag_schedule_undo_at"
                        type="datetime-local"
                        defaultValue=""
                      />
                    </label>
                  </div>

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      type="submit"
                      name="intent"
                      value="auto_tag_apply"
                      formNoValidate
                      disabled={autoTagJob?.status === "running"}
                    >
                      Apply auto tag action
                    </button>
                    <button type="submit" name="intent" value="auto_tag_run_due" formNoValidate>
                      Run due scheduled undos
                    </button>
                  </div>
                </div>

                <div style={cardStyle}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a", marginBottom: 8 }}>
                    History
                  </div>
                  {(config.auto_tagging?.history ?? []).length === 0 ? (
                    <div style={{ fontSize: 13, color: "#64748b" }}>No history yet.</div>
                  ) : (
                    <div style={{ display: "grid", gap: 8 }}>
                      {(config.auto_tagging?.history ?? []).map((h) => {
                        const addedTags = Array.from(
                          new Set((h.changes ?? []).flatMap((c) => c.added_tags ?? []).filter(Boolean)),
                        );
                        const removedTags = Array.from(
                          new Set((h.changes ?? []).flatMap((c) => c.removed_tags ?? []).filter(Boolean)),
                        );
                        return (
                        <div
                          key={h.id}
                          style={{
                            border: "1px solid rgba(17,24,39,0.12)",
                            borderRadius: 8,
                            padding: "8px 10px",
                            background: "#fff",
                            display: "grid",
                            gap: 4,
                          }}
                        >
                          <div style={{ fontSize: 12, color: "#334155" }}>
                            <strong>
                              {h.mode === "tag"
                                ? "Tag"
                                : h.mode === "untag_discount"
                                  ? "Untag discount"
                                  : "Undo action"}
                            </strong>{" "}
                            | {new Date(h.created_at).toLocaleString()} | changed {(h.changes ?? []).length} listing(s)
                          </div>
                          <div style={{ fontSize: 12, color: "#334155" }}>
                            <strong>SKUs:</strong> {(h.input_skus ?? []).join(", ") || "-"}
                          </div>
                          <div style={{ fontSize: 12, color: "#334155" }}>
                            <strong>Tag:</strong> {h.target_tag || "-"}
                          </div>
                          <div style={{ fontSize: 12, color: "#334155" }}>
                            <strong>Added tags:</strong> {addedTags.length ? addedTags.join(", ") : "-"}
                          </div>
                          <div style={{ fontSize: 12, color: "#334155" }}>
                            <strong>Removed tags:</strong> {removedTags.length ? removedTags.join(", ") : "-"}
                          </div>
                          <div style={{ fontSize: 12, color: "#334155" }}>
                            <strong>Undo:</strong>{" "}
                            {h.undone_at
                              ? `Done at ${new Date(h.undone_at).toLocaleString()}`
                              : h.scheduled_undo_at
                                ? `Scheduled ${new Date(h.scheduled_undo_at).toLocaleString()}`
                                : "Not scheduled"}
                          </div>
                          {!h.undone_at ? (
                            <div>
                              <button
                                type="submit"
                                name="intent"
                                value="auto_tag_undo"
                                formNoValidate
                                onClick={(e) => {
                                  const form = e.currentTarget.form;
                                  if (!form) return;
                                  const existing = form.querySelector("input[name='auto_tag_history_id'][data-auto-undo='1']");
                                  if (existing) existing.remove();
                                  const hidden = document.createElement("input");
                                  hidden.type = "hidden";
                                  hidden.name = "auto_tag_history_id";
                                  hidden.value = h.id;
                                  hidden.setAttribute("data-auto-undo", "1");
                                  form.appendChild(hidden);
                                }}
                              >
                                Undo this entry
                              </button>
                            </div>
                          ) : null}
                        </div>
                      )})}
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            {tab === "review" ? (
              <div style={{ display: "grid", gap: 10 }}>
                <div style={cardStyle}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a" }}>Quick Preview</div>
                  <div style={{ marginTop: 4, fontSize: 13, color: "#475569" }}>
                    Fast estimate based on your current settings. This is a sanity check only.
                  </div>
                  <div
                    style={{
                      marginTop: 10,
                      display: "grid",
                      gap: 10,
                      gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
                    }}
                  >
                    <label style={labelStyle}>
                      Cart subtotal ($)
                      <input
                        style={inputStyle}
                        type="number"
                        min="0"
                        step="0.01"
                        value={previewSubtotal}
                        onChange={(e) => setPreviewSubtotal(Number(e.currentTarget.value || "0"))}
                      />
                    </label>
                    <label style={labelStyle}>
                      Eligible Other-Discount units
                      <input
                        style={inputStyle}
                        type="number"
                        min="0"
                        step="1"
                        value={previewOtherEligibleQty}
                        onChange={(e) =>
                          setPreviewOtherEligibleQty(Math.max(0, Math.trunc(Number(e.currentTarget.value || "0"))))
                        }
                      />
                    </label>
                    <label style={labelStyle}>
                      Eligible unit price cap ($)
                      <input
                        style={inputStyle}
                        type="number"
                        min="0"
                        step="0.01"
                        value={previewOtherUnitPrice}
                        onChange={(e) => setPreviewOtherUnitPrice(Number(e.currentTarget.value || "0"))}
                      />
                    </label>
                  </div>
                  <div style={{ marginTop: 10, fontSize: 13, color: "#334155", display: "grid", gap: 4 }}>
                    <div>
                      <strong>Bulk tier preview:</strong>{" "}
                      {previewBulkPercent > 0 ? `${previewBulkPercent}%` : "No bulk discount"}
                    </div>
                    <div>
                      <strong>Other discount units:</strong> {previewOtherUnits} unit(s)
                    </div>
                    <div>
                      <strong>Other discount total:</strong> ${previewOtherTotal.toFixed(2)}{" "}
                      ({previewOtherUnits} x ${previewOtherPerUnit.toFixed(2)})
                    </div>
                    <div style={{ color: "#64748b" }}>
                      Allocation rule: highest-priced eligible units are discounted first.
                    </div>
                  </div>
                </div>
                {((actionData?.conflicts as any[]) ?? conflicts).length ? (
                  <s-banner tone="warning">
                    There are products present in other discount collections that will conflict.
                  </s-banner>
                ) : (
                  <s-banner tone="success">No cross-collection conflicts detected.</s-banner>
                )}
                {((actionData?.conflicts as any[]) ?? conflicts).length ? (
                  <div style={cardStyle}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a", marginBottom: 8 }}>
                      Conflicting items
                    </div>
                    <div style={{ display: "grid", gap: 8 }}>
                      {((actionData?.conflicts as any[]) ?? conflicts).map((c: any, idx: number) => (
                        <div
                          key={`${c?.product_id ?? "unknown"}:${idx}`}
                          style={{
                            border: "1px solid rgba(17,24,39,0.12)",
                            borderRadius: 8,
                            padding: "8px 10px",
                            background: "#fff",
                          }}
                        >
                          <div style={{ fontSize: 12, color: "#334155" }}>
                            <strong>Product ID:</strong> {String(c?.product_id ?? "")}
                          </div>
                          <div style={{ fontSize: 12, color: "#334155", marginTop: 4 }}>
                            <strong>Conflicting rules:</strong>{" "}
                            {Array.isArray(c?.rules) ? c.rules.join(", ") : ""}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div style={{ padding: 12, borderTop: "1px solid rgba(17,24,39,0.1)", background: "#F8FAFC", position: "sticky", bottom: 0 }}>
            <button type="submit" disabled={isSaving} style={{ background: isSaving ? "#94A3B8" : "#0B79E3", color: "white", border: "none", borderRadius: 9, padding: "10px 14px" }}>
              {isSaving ? "Saving..." : "Save settings"}
            </button>
          </div>
        </form>
      </div>
    </s-page>
  );
}
