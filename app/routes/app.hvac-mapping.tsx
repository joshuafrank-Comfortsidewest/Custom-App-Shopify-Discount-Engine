import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { useActionData, useFetcher, useLoaderData, useNavigation, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

type MappingRow = {
  id: number;
  sourceSku: string;
  sourceType: string | null;
  matchStatus: string;
  mappedVariantId: string | null;
  mappedVariantSku: string | null;
  mappedProductTitle: string | null;
  mappedProductId: string | null;
  mappedProductHandle: string | null;
  mappedProductUrl: string | null;
  note: string | null;
  updatedAt: string;
};
type MappingRowDb = Omit<MappingRow, "updatedAt"> & { updatedAt: Date | string };

type ActionResult = { ok: boolean; message: string };
type SkuSourceMeta = {
  sourceBrand: string | null;
  sourceSeries: string | null;
  sourceSystem: string | null;
  sourceBtu: number | null;
  sourceRefrigerant: string | null;
};

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCsv(content: string): Array<Record<string, string>> {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j += 1) {
      row[headers[j]] = (values[j] ?? "").trim();
    }
    rows.push(row);
  }
  return rows;
}

function norm(v: unknown) {
  return String(v ?? "").trim();
}

function normKey(v: unknown) {
  return String(v ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function csvValue(row: Record<string, string>, candidates: string[]) {
  const wanted = new Set(candidates.map((c) => normKey(c)));
  for (const [k, v] of Object.entries(row)) {
    if (wanted.has(normKey(k))) return norm(v);
  }
  return "";
}

function toIntOrNull(v: unknown) {
  const raw = norm(v);
  if (!raw) return null;
  // Prefer the first BTU-like number only, e.g. "6,000/9,000/12,000" -> 6000.
  const m = raw.match(/(\d[\d,]{2,6})/);
  if (!m) return null;
  const cleaned = String(m[1]).replace(/,/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  const vInt = Math.trunc(n);
  // Keep sane BTU range only.
  if (vInt < 1000 || vInt > 60000) return null;
  return vInt;
}

function toVariantGid(raw: string) {
  const v = norm(raw);
  if (!v) return "";
  if (v.startsWith("gid://")) return v;
  if (/^\d+$/.test(v)) return `gid://shopify/ProductVariant/${v}`;
  return v;
}

function toProductGid(raw: string) {
  const v = norm(raw);
  if (!v) return "";
  if (v.startsWith("gid://shopify/Product/")) return v;
  if (/^\d+$/.test(v)) return `gid://shopify/Product/${v}`;
  return "";
}

async function adminGraphql(admin: any, query: string, variables: Record<string, unknown>) {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();
  return json;
}

async function lookupBySku(admin: any, sku: string) {
  const json = await adminGraphql(
    admin,
    `#graphql
      query ProductVariantsBySku($q: String!) {
        productVariants(first: 10, query: $q) {
          nodes {
            id
            sku
            title
            product {
              id
              title
              handle
              status
              onlineStoreUrl
            }
          }
        }
      }`,
    { q: `sku:${sku}` },
  );
  const nodes = json?.data?.productVariants?.nodes ?? [];
  const exact = nodes.filter((n: any) => norm(n?.sku).toLowerCase() === sku.toLowerCase());
  if (exact.length === 1) {
    return {
      mode: "auto_exact",
      variant: exact[0],
      product: exact[0]?.product ?? null,
      note: null as string | null,
    };
  }
  if (exact.length > 1) {
    const productIds = [...new Set(exact.map((n: any) => n?.product?.id).filter(Boolean))];
    if (productIds.length === 1) {
      return {
        mode: "auto_exact_product",
        variant: null,
        product: exact[0]?.product ?? null,
        note: `Multiple exact variants found (${exact.length}) in same product; mapped to product`,
      };
    }
    return {
      mode: "not_found",
      variant: null,
      product: null,
      note: `Multiple exact variants found across different products (${exact.length}); manual mapping required`,
    };
  }
  if (nodes.length === 1) {
    return {
      mode: "auto_fuzzy",
      variant: nodes[0],
      product: nodes[0]?.product ?? null,
      note: "No exact SKU; used single fuzzy result",
    };
  }
  if (nodes.length > 1) {
    return { mode: "not_found", variant: null, product: null, note: `Multiple fuzzy matches found (${nodes.length})` };
  }
  return { mode: "not_found", variant: null, product: null, note: "No product variant found for SKU" };
}

async function lookupByVariantId(admin: any, variantId: string) {
  try {
    const json = await adminGraphql(
      admin,
      `#graphql
        query VariantById($id: ID!) {
          productVariant(id: $id) {
            id
            sku
            title
            product {
              id
              title
              handle
              status
              onlineStoreUrl
            }
          }
        }`,
      { id: variantId },
    );
    return json?.data?.productVariant ?? null;
  } catch {
    return null;
  }
}

async function lookupByProductId(admin: any, productId: string, sourceSku: string) {
  try {
    const json = await adminGraphql(
      admin,
      `#graphql
        query ProductById($id: ID!) {
          product(id: $id) {
            id
            title
            handle
            onlineStoreUrl
            variants(first: 100) {
              nodes {
                id
                sku
              }
            }
          }
        }`,
      { id: productId },
    );
    const product = json?.data?.product ?? null;
    if (!product) return null;
    const variants = product?.variants?.nodes ?? [];
    const exact = variants.find((v: any) => norm(v?.sku).toLowerCase() === sourceSku.toLowerCase()) ?? null;
    const picked = exact ?? variants[0] ?? null;
    return {
      id: picked?.id ?? null,
      sku: picked?.sku ?? null,
      product,
    };
  } catch {
    return null;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const q = norm(url.searchParams.get("q"));
  const status = norm(url.searchParams.get("status"));
  const take = Math.min(500, Math.max(25, Number(url.searchParams.get("take") ?? 200)));

  const whereSql: string[] = [`"shop" = ?`];
  const whereParams: Array<string> = [shop];
  if (q) {
    whereSql.push(`"sourceSku" LIKE ?`);
    whereParams.push(`%${q}%`);
  }
  if (status && status !== "all") {
    whereSql.push(`"matchStatus" = ?`);
    whereParams.push(status);
  }

  const [rows, total, mapped, unmapped] = await Promise.all([
    prisma.$queryRawUnsafe<MappingRowDb[]>(
      `SELECT
        "id",
        "sourceSku",
        "sourceType",
        "matchStatus",
        "mappedVariantId",
        "mappedVariantSku",
        "mappedProductTitle",
        "mappedProductId",
        "mappedProductHandle",
        "mappedProductUrl",
        "note",
        "updatedAt"
      FROM "HvacSkuMapping"
      WHERE ${whereSql.join(" AND ")}
      ORDER BY "sourceSku" ASC
      LIMIT ?`,
      ...whereParams,
      take,
    ),
    prisma.hvacSkuMapping.count({ where: { shop } }),
    prisma.hvacSkuMapping.count({ where: { shop, mappedProductId: { not: null } } }),
    prisma.hvacSkuMapping.count({
      where: { shop, OR: [{ mappedProductId: null }, { matchStatus: "not_found" }] },
    }),
  ]);

  return {
    shop,
    q,
    status: status || "all",
    take,
    rows: rows.map((r) => ({
      ...r,
      updatedAt:
        r.updatedAt instanceof Date
          ? r.updatedAt.toISOString()
          : new Date(String(r.updatedAt)).toISOString(),
    })) as MappingRow[],
    stats: { total, mapped, unmapped },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = norm(form.get("intent"));

  if (intent === "import_csv") {
    const sheet22 = form.get("sheet22_file");
    const sheet23 = form.get("sheet23_file");
    const extraSkusText = norm(form.get("extra_skus"));

    const skuTypes = new Map<string, string>();
    const skuMeta = new Map<string, SkuSourceMeta>();

    if (sheet22 instanceof File && sheet22.size > 0) {
      const rows = parseCsv(await sheet22.text());
      for (const r of rows) {
        const sku = csvValue(r, ["SKU"]);
        if (!sku) continue;
        skuTypes.set(sku, "indoor");
        if (!skuMeta.has(sku)) {
          skuMeta.set(sku, {
            sourceBrand: csvValue(r, ["Brand"]) || null,
            sourceSeries: csvValue(r, ["Series"]) || null,
            sourceSystem: csvValue(r, ["System"]) || null,
            sourceBtu: toIntOrNull(csvValue(r, ["BTU"])),
            sourceRefrigerant: csvValue(r, ["Refrigerant"]) || null,
          });
        }
      }
    }

    if (sheet23 instanceof File && sheet23.size > 0) {
      const rows = parseCsv(await sheet23.text());
      for (const r of rows) {
        const sku = csvValue(r, ["Condenser", "Condenser SKU", "Outdoor SKU", "Outdoor"]);
        if (!sku) continue;
        // Sheet23 is the combo source of truth for condenser SKUs.
        // If a SKU appears in both sheets, it must be treated as outdoor.
        skuTypes.set(sku, "outdoor");
        const existing = skuMeta.get(sku);
        skuMeta.set(sku, {
          sourceBrand: csvValue(r, ["Brand"]) || existing?.sourceBrand || null,
          sourceSeries: csvValue(r, ["Series"]) || existing?.sourceSeries || null,
          sourceSystem:
            csvValue(r, ["Standard/Hyper", "System"]) || existing?.sourceSystem || null,
          sourceBtu: existing?.sourceBtu ?? null,
          sourceRefrigerant: csvValue(r, ["Refrigerant"]) || existing?.sourceRefrigerant || null,
        });
      }
    }

    if (extraSkusText) {
      for (const raw of extraSkusText.split(/\s|,|;/g)) {
        const sku = norm(raw);
        if (!sku) continue;
        if (!skuTypes.has(sku)) skuTypes.set(sku, "unknown");
      }
    }

    let upserts = 0;
    let autoMatched = 0;
    let notFound = 0;
    for (const [sku, sourceType] of skuTypes.entries()) {
      const meta = skuMeta.get(sku);
      const base = await prisma.hvacSkuMapping.upsert({
        where: { shop_sourceSku: { shop, sourceSku: sku } },
        create: {
          shop,
          sourceSku: sku,
          sourceType,
          matchStatus: "unmapped",
        },
        update: { sourceType },
      });
      upserts += 1;

      // Best-effort metadata write via SQL so this route remains compatible
      // even if the running Prisma client schema is stale.
      if (meta) {
        try {
          await prisma.$executeRawUnsafe(
            `UPDATE "HvacSkuMapping"
             SET "sourceBrand" = ?, "sourceSeries" = ?, "sourceSystem" = ?, "sourceBtu" = ?, "sourceRefrigerant" = ?
             WHERE "shop" = ? AND "sourceSku" = ?`,
            meta.sourceBrand,
            meta.sourceSeries,
            meta.sourceSystem,
            meta.sourceBtu,
            meta.sourceRefrigerant,
            shop,
            sku,
          );
        } catch {
          // Ignore if metadata columns are unavailable in this runtime.
        }
      }

      try {
        const found = await lookupBySku(admin, sku);
        if (!found.variant && !found.product) {
          notFound += 1;
          await prisma.hvacSkuMapping.update({
            where: { shop_sourceSku: { shop, sourceSku: base.sourceSku } },
            data: {
              matchStatus: "not_found",
              note: found.note,
            },
          });
          continue;
        }

        autoMatched += 1;
        await prisma.hvacSkuMapping.update({
          where: { shop_sourceSku: { shop, sourceSku: base.sourceSku } },
          data: {
            mappedVariantId: found.variant?.id ?? null,
            mappedVariantSku: found.variant ? norm(found.variant.sku) || null : null,
            mappedProductId: found.product?.id ?? null,
            mappedProductTitle: found.product?.title ?? null,
            mappedProductHandle: found.product?.handle ?? null,
            mappedProductUrl: found.product?.onlineStoreUrl ?? null,
            matchStatus: found.mode,
            note: found.note,
          },
        });
      } catch (error: any) {
        await prisma.hvacSkuMapping.update({
          where: { shop_sourceSku: { shop, sourceSku: base.sourceSku } },
          data: {
            matchStatus: "error",
            note: String(error?.message ?? error),
          },
        });
      }
    }

    return {
      ok: true,
      message: `Imported ${upserts} SKUs | Auto-matched ${autoMatched} | Not found ${notFound}`,
    } satisfies ActionResult;
  }

  if (intent === "auto_match_one") {
    const sku = norm(form.get("sku"));
    if (!sku) return { ok: false, message: "Missing SKU" } satisfies ActionResult;

    const found = await lookupBySku(admin, sku);
    if (!found.variant && !found.product) {
      await prisma.hvacSkuMapping.update({
        where: { shop_sourceSku: { shop, sourceSku: sku } },
        data: { matchStatus: "not_found", note: found.note },
      });
      return { ok: false, message: `${sku}: ${found.note}` } satisfies ActionResult;
    }

    await prisma.hvacSkuMapping.update({
      where: { shop_sourceSku: { shop, sourceSku: sku } },
      data: {
        mappedVariantId: found.variant?.id ?? null,
        mappedVariantSku: found.variant ? norm(found.variant.sku) || null : null,
        mappedProductId: found.product?.id ?? null,
        mappedProductTitle: found.product?.title ?? null,
        mappedProductHandle: found.product?.handle ?? null,
        mappedProductUrl: found.product?.onlineStoreUrl ?? null,
        matchStatus: found.mode,
        note: found.note,
      },
    });
    return { ok: true, message: `${sku}: matched` } satisfies ActionResult;
  }

  if (intent === "bulk_auto_match") {
    const rows = await prisma.$queryRawUnsafe<Array<{ sourceSku: string }>>(
      `SELECT "sourceSku"
       FROM "HvacSkuMapping"
       WHERE "shop" = ?
         AND ("mappedProductId" IS NULL OR "matchStatus" = 'unmapped' OR "matchStatus" = 'not_found' OR "matchStatus" = 'error')
       ORDER BY "sourceSku" ASC`,
      shop,
    );

    let matched = 0;
    let notFound = 0;

    for (const row of rows) {
      try {
        const found = await lookupBySku(admin, row.sourceSku);
        if (!found.variant && !found.product) {
          notFound += 1;
          await prisma.hvacSkuMapping.update({
            where: { shop_sourceSku: { shop, sourceSku: row.sourceSku } },
            data: { matchStatus: "not_found", note: found.note },
          });
          continue;
        }
        matched += 1;
        await prisma.hvacSkuMapping.update({
          where: { shop_sourceSku: { shop, sourceSku: row.sourceSku } },
          data: {
            mappedVariantId: found.variant?.id ?? null,
            mappedVariantSku: found.variant ? norm(found.variant.sku) || null : null,
            mappedProductId: found.product?.id ?? null,
            mappedProductTitle: found.product?.title ?? null,
            mappedProductHandle: found.product?.handle ?? null,
            mappedProductUrl: found.product?.onlineStoreUrl ?? null,
            matchStatus: found.mode,
            note: found.note,
          },
        });
      } catch (error: any) {
        await prisma.hvacSkuMapping.update({
          where: { shop_sourceSku: { shop, sourceSku: row.sourceSku } },
          data: {
            matchStatus: "error",
            note: String(error?.message ?? error),
          },
        });
      }
    }

    return { ok: true, message: `Bulk match finished: ${matched} matched, ${notFound} not found` } satisfies ActionResult;
  }

  if (intent === "save_manual_variant") {
    const sku = norm(form.get("sku"));
    const variantIdInput = norm(form.get("variant_id"));
    const sourceTypeInput = norm(form.get("source_type")).toLowerCase();
    const sourceType =
      sourceTypeInput === "indoor" || sourceTypeInput === "outdoor" || sourceTypeInput === "unknown"
        ? sourceTypeInput
        : null;
    if (!sku || !variantIdInput) return { ok: false, message: "Missing SKU or ID" } satisfies ActionResult;

    let variant: any = null;
    let productFromProductLookup: any = null;
    const normalizedVariant = toVariantGid(variantIdInput);
    const productCandidates = new Set<string>();
    if (variantIdInput.includes("/Product/")) {
      const explicit = norm(variantIdInput);
      if (explicit) productCandidates.add(explicit);
    }
    const productFromNumeric = toProductGid(variantIdInput);
    if (productFromNumeric) productCandidates.add(productFromNumeric);

    // If a product ID is provided (or a plain numeric ID), prefer product lookup.
    for (const productCandidate of productCandidates) {
      const productLookup = await lookupByProductId(admin, productCandidate, sku);
      if (!productLookup?.product) continue;
      productFromProductLookup = productLookup.product;
      variant = productLookup.id ? { id: productLookup.id, sku: productLookup.sku } : null;
      break;
    }

    // Fallback to variant lookup when product lookup doesn't resolve.
    if (!variant && !productFromProductLookup) {
      variant = await lookupByVariantId(admin, normalizedVariant);
    }

    if (!variant && !productFromProductLookup) {
      return {
        ok: false,
        message: `Variant/Product not found or invalid ID: ${variantIdInput}`,
      } satisfies ActionResult;
    }

    await prisma.hvacSkuMapping.update({
      where: { shop_sourceSku: { shop, sourceSku: sku } },
      data: {
        mappedVariantId: variant?.id ?? null,
        mappedVariantSku: variant ? norm(variant.sku) || null : null,
        mappedProductId: variant.product?.id ?? productFromProductLookup?.id ?? null,
        mappedProductTitle: variant.product?.title ?? productFromProductLookup?.title ?? null,
        mappedProductHandle: variant.product?.handle ?? productFromProductLookup?.handle ?? null,
        mappedProductUrl: variant.product?.onlineStoreUrl ?? productFromProductLookup?.onlineStoreUrl ?? null,
        ...(sourceType ? { sourceType } : {}),
        matchStatus: "manual",
        note: null,
      },
    });
    return {
      ok: true,
      message:
        `${sku}: manual mapping saved. Re-open the discount and click Save settings to refresh HVAC runtime IDs for checkout.`,
    } satisfies ActionResult;
  }

  if (intent === "export_json") {
    const rows = await prisma.$queryRawUnsafe<
      Array<{
        sourceSku: string;
        mappedProductId: string | null;
        matchStatus: string;
        mappedVariantId: string | null;
        mappedProductHandle: string | null;
        mappedProductUrl: string | null;
      }>
    >(
      `SELECT
        "sourceSku",
        "mappedProductId",
        "matchStatus",
        "mappedVariantId",
        "mappedProductHandle",
        "mappedProductUrl"
       FROM "HvacSkuMapping"
       WHERE "shop" = ?
       ORDER BY "sourceSku" ASC`,
      shop,
    );
    const payload = {
      version: 1,
      generatedAt: new Date().toISOString(),
      store: { shop },
      sources: { from: "ui_mapping" },
      stats: {
        totalSkus: rows.length,
        matched: rows.filter((r) => !!r.mappedProductId).length,
        unmatched: rows.filter((r) => !r.mappedProductId).length,
      },
      entries: rows.map((r) => ({
        sku: r.sourceSku,
        matched: Boolean(r.mappedProductId),
        matchMode: r.matchStatus,
        variantId: r.mappedVariantId,
        productId: r.mappedProductId,
        productHandle: r.mappedProductHandle,
        productUrl: r.mappedProductUrl,
      })),
    };

    const fs = await import("node:fs");
    const path = await import("node:path");
    const out = path.resolve("app/data/hvac/hvac-sku-map.json");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    return { ok: true, message: `Exported ${rows.length} rows to app/data/hvac/hvac-sku-map.json` } satisfies ActionResult;
  }

  return { ok: false, message: "Unknown action" } satisfies ActionResult;
};

export default function HvacMappingPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionResult>();
  const revalidator = useRevalidator();
  const importFetcher = useFetcher<ActionResult>();
  const bulkFetcher = useFetcher<ActionResult>();
  const exportFetcher = useFetcher<ActionResult>();
  const rowFetcher = useFetcher<ActionResult>();
  const [filterSku, setFilterSku] = useState(data.q ?? "");
  const [filterStatus, setFilterStatus] = useState(data.status ?? "all");
  const nav = useNavigation();
  const isBusy =
    nav.state !== "idle" ||
    importFetcher.state !== "idle" ||
    bulkFetcher.state !== "idle" ||
    exportFetcher.state !== "idle" ||
    rowFetcher.state !== "idle";
  const flash =
    rowFetcher.data ?? exportFetcher.data ?? bulkFetcher.data ?? importFetcher.data ?? actionData ?? null;

  useEffect(() => {
    const shouldRefresh =
      (importFetcher.state === "idle" && importFetcher.data != null) ||
      (bulkFetcher.state === "idle" && bulkFetcher.data != null) ||
      (rowFetcher.state === "idle" && rowFetcher.data != null);
    if (shouldRefresh && revalidator.state === "idle") {
      revalidator.revalidate();
    }
  }, [
    importFetcher.state,
    importFetcher.data,
    bulkFetcher.state,
    bulkFetcher.data,
    rowFetcher.state,
    rowFetcher.data,
    revalidator,
  ]);

  const visibleRows = useMemo(() => {
    const q = String(filterSku ?? "").trim().toLowerCase();
    return data.rows.filter((row) => {
      if (filterStatus && filterStatus !== "all" && row.matchStatus !== filterStatus) return false;
      if (q && !row.sourceSku.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data.rows, filterSku, filterStatus]);

  return (
    <s-page heading="HVAC SKU Mapping">
      <s-section heading="Setup">
        <s-paragraph>
          Import your HVAC CSVs. The app will auto-match each source SKU to a store variant by SKU, then you can review and confirm.
        </s-paragraph>
        {flash?.message ? (
          <s-banner tone={flash.ok ? "success" : "critical"}>{flash.message}</s-banner>
        ) : null}
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <importFetcher.Form method="post" encType="multipart/form-data">
            <input type="hidden" name="intent" value="import_csv" />
            <div style={{ display: "grid", gap: 10 }}>
              <label>
                Sheet22 CSV (indoor SKUs)
                <input name="sheet22_file" type="file" accept=".csv,text/csv" />
              </label>
              <label>
                Sheet23 CSV (outdoor SKUs / condenser)
                <input name="sheet23_file" type="file" accept=".csv,text/csv" />
              </label>
              <label>
                Extra SKUs (optional)
                <textarea name="extra_skus" rows={3} placeholder="Paste SKUs separated by comma/space/new line" />
              </label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="submit" disabled={isBusy}>
                  Import + Auto Match
                </button>
              </div>
            </div>
          </importFetcher.Form>
        </s-box>
      </s-section>

      <s-section heading="Bulk Actions">
        <s-stack direction="inline" gap="base">
          <bulkFetcher.Form method="post">
            <input type="hidden" name="intent" value="bulk_auto_match" />
            <button type="submit" disabled={isBusy}>
              Auto-match all unmapped
            </button>
          </bulkFetcher.Form>
          <exportFetcher.Form method="post">
            <input type="hidden" name="intent" value="export_json" />
            <button type="submit" disabled={isBusy}>
              Export JSON for catalog build
            </button>
          </exportFetcher.Form>
        </s-stack>
        <s-paragraph>
          Shop: <strong>{data.shop}</strong> | Total: {data.stats.total} | Mapped: {data.stats.mapped} | Unmapped:{" "}
          {data.stats.unmapped}
        </s-paragraph>
      </s-section>

      <s-section heading="Mappings">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <input
            type="text"
            value={filterSku}
            onChange={(e) => setFilterSku(e.currentTarget.value)}
            placeholder="Filter by SKU"
          />
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.currentTarget.value)}>
            <option value="all">All statuses</option>
            <option value="unmapped">unmapped</option>
            <option value="auto_exact">auto_exact</option>
            <option value="auto_exact_product">auto_exact_product</option>
            <option value="auto_fuzzy">auto_fuzzy</option>
            <option value="manual">manual</option>
            <option value="not_found">not_found</option>
            <option value="error">error</option>
          </select>
          <button type="button" onClick={() => { setFilterSku(""); setFilterStatus("all"); }}>
            Clear filter
          </button>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Source SKU</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Type</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Status</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Mapped Product</th>
                <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: 6 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.id}>
                  <td style={{ borderBottom: "1px solid #f1f1f1", padding: 6 }}>
                    <code>{row.sourceSku}</code>
                  </td>
                  <td style={{ borderBottom: "1px solid #f1f1f1", padding: 6 }}>{row.sourceType ?? "unknown"}</td>
                  <td style={{ borderBottom: "1px solid #f1f1f1", padding: 6 }}>{row.matchStatus}</td>
                  <td style={{ borderBottom: "1px solid #f1f1f1", padding: 6 }}>
                    {row.mappedProductTitle ? (
                      <div>
                        <div>{row.mappedProductTitle}</div>
                        <small>
                          {row.mappedVariantSku ?? ""} {row.mappedProductUrl ? `| ${row.mappedProductUrl}` : ""}
                        </small>
                      </div>
                    ) : (
                      <span>-</span>
                    )}
                    {row.note ? <div style={{ color: "#8a6116" }}>{row.note}</div> : null}
                  </td>
                  <td style={{ borderBottom: "1px solid #f1f1f1", padding: 6 }}>
                    <div style={{ display: "grid", gap: 6 }}>
                      <small>Confirm/refresh mapping:</small>
                      <rowFetcher.Form method="post">
                        <input type="hidden" name="intent" value="auto_match_one" />
                        <input type="hidden" name="sku" value={row.sourceSku} />
                        <button type="submit" disabled={isBusy}>
                          Re-run Auto Match
                        </button>
                      </rowFetcher.Form>
                      <rowFetcher.Form method="post">
                        <input type="hidden" name="intent" value="save_manual_variant" />
                        <input type="hidden" name="sku" value={row.sourceSku} />
                        <select
                          name="source_type"
                          defaultValue={
                            row.sourceType === "indoor" || row.sourceType === "outdoor" || row.sourceType === "unknown"
                              ? row.sourceType
                              : "unknown"
                          }
                        >
                          <option value="unknown">unknown</option>
                          <option value="indoor">indoor</option>
                          <option value="outdoor">outdoor</option>
                        </select>
                        <input
                          type="text"
                          name="variant_id"
                          placeholder="Product ID or Variant ID (numeric or gid://...)"
                          defaultValue={row.mappedVariantId ?? ""}
                          style={{ width: 320 }}
                        />
                        <button type="submit" disabled={isBusy}>
                          Save manual
                        </button>
                      </rowFetcher.Form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </s-section>
    </s-page>
  );
}
