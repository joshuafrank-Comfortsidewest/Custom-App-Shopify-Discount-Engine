#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function parseCsv(content) {
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const values = parseCsvLine(line);
    const row = {};
    for (let j = 0; j < headers.length; j += 1) {
      row[headers[j]] = (values[j] ?? "").trim();
    }
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line) {
  const out = [];
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function adminGraphql({ shop, token, query, variables }) {
  const url = `https://${shop}/admin/api/2025-10/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  const json = await res.json();
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

function normalizeSku(v) {
  return String(v ?? "").trim();
}

function collectSkus(sheet22Rows, sheet23Rows) {
  const set = new Set();
  for (const r of sheet22Rows) {
    const sku = normalizeSku(r["SKU"]);
    if (sku) set.add(sku);
  }
  for (const r of sheet23Rows) {
    const sku = normalizeSku(r["Condenser"]);
    if (sku) set.add(sku);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function pickExactSku(edges, wantedSku) {
  const wanted = wantedSku.toLowerCase();
  const exact = edges.filter((e) => String(e?.node?.sku ?? "").trim().toLowerCase() === wanted);
  if (exact.length === 1) return { mode: "exact", node: exact[0].node, candidates: edges.map((e) => e.node) };
  if (exact.length > 1) return { mode: "multiple_exact", node: exact[0].node, candidates: exact.map((e) => e.node) };
  if (edges.length === 1) return { mode: "fuzzy_single", node: edges[0].node, candidates: edges.map((e) => e.node) };
  if (edges.length > 1) return { mode: "multiple_fuzzy", node: null, candidates: edges.map((e) => e.node) };
  return { mode: "none", node: null, candidates: [] };
}

async function matchOneSku({ shop, token, sku }) {
  const query = `
    query ProductVariantsBySku($q: String!) {
      productVariants(first: 10, query: $q) {
        edges {
          node {
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
      }
    }
  `;

  const data = await adminGraphql({
    shop,
    token,
    query,
    variables: { q: `sku:${sku}` },
  });
  const edges = data?.productVariants?.edges ?? [];
  const picked = pickExactSku(edges, sku);
  const node = picked.node;
  return {
    sku,
    matched: Boolean(node),
    matchMode: picked.mode,
    variantId: node?.id ?? null,
    productId: node?.product?.id ?? null,
    productHandle: node?.product?.handle ?? null,
    productTitle: node?.product?.title ?? null,
    productStatus: node?.product?.status ?? null,
    productUrl: node?.product?.onlineStoreUrl ?? null,
    candidateCount: picked.candidates.length,
    candidates: picked.candidates.map((c) => ({
      variantId: c.id,
      sku: c.sku,
      productId: c.product?.id ?? null,
      productHandle: c.product?.handle ?? null,
      productTitle: c.product?.title ?? null,
    })),
  };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function usageAndExit() {
  console.error(
    "Usage: node scripts/match-hvac-skus-to-store.mjs --sheet22 <csv> [--sheet23 <csv>] [--shop <shop-domain>] [--token <admin-token>] [--out <json>]",
  );
  process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv);
  const sheet22 = args.sheet22;
  const sheet23 = args.sheet23;
  const shop = args.shop ?? process.env.SHOPIFY_SHOP;
  const token = args.token ?? process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  const out = args.out ?? "app/data/hvac/hvac-sku-map.json";

  if (!sheet22) usageAndExit();
  if (!shop || !token) {
    console.error("Missing credentials. Provide --shop/--token or set SHOPIFY_SHOP and SHOPIFY_ADMIN_ACCESS_TOKEN.");
    process.exit(1);
  }

  const sheet22Rows = parseCsv(fs.readFileSync(sheet22, "utf8"));
  const sheet23Rows = sheet23 ? parseCsv(fs.readFileSync(sheet23, "utf8")) : [];
  const skus = collectSkus(sheet22Rows, sheet23Rows);

  const entries = [];
  for (let i = 0; i < skus.length; i += 1) {
    const sku = skus[i];
    try {
      const matched = await matchOneSku({ shop, token, sku });
      entries.push(matched);
    } catch (error) {
      entries.push({
        sku,
        matched: false,
        matchMode: "error",
        error: String(error?.message ?? error),
        variantId: null,
        productId: null,
        productHandle: null,
        productTitle: null,
        productStatus: null,
        productUrl: null,
        candidateCount: 0,
        candidates: [],
      });
    }
    if ((i + 1) % 25 === 0 || i === skus.length - 1) {
      console.log(`Matched ${i + 1}/${skus.length} SKUs`);
    }
    await sleep(80);
  }

  const stats = {
    totalSkus: skus.length,
    matched: entries.filter((e) => e.matched).length,
    unmatched: entries.filter((e) => !e.matched).length,
    exact: entries.filter((e) => e.matchMode === "exact").length,
    multipleExact: entries.filter((e) => e.matchMode === "multiple_exact").length,
    fuzzySingle: entries.filter((e) => e.matchMode === "fuzzy_single").length,
    multipleFuzzy: entries.filter((e) => e.matchMode === "multiple_fuzzy").length,
    errors: entries.filter((e) => e.matchMode === "error").length,
  };

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    store: { shop },
    sources: {
      sheet22: path.resolve(sheet22),
      sheet23: sheet23 ? path.resolve(sheet23) : null,
    },
    stats,
    entries,
  };

  ensureDir(path.dirname(out));
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${out}`);
  console.log(JSON.stringify(stats, null, 2));
}

main();
