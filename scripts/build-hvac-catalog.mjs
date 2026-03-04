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

function asInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normBrand(v) {
  return String(v ?? "").trim();
}

function nullIfEmpty(v) {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

function loadSkuMap(skuMapJson) {
  const out = new Map();
  if (!skuMapJson) return out;
  const entries = Array.isArray(skuMapJson.entries) ? skuMapJson.entries : [];
  for (const e of entries) {
    const sku = String(e?.sku ?? "").trim();
    if (!sku) continue;
    out.set(sku, {
      sku,
      variantId: e?.variantId ?? null,
      productId: e?.productId ?? null,
      productHandle: e?.productHandle ?? null,
      productUrl: e?.productUrl ?? null,
      matched: Boolean(e?.matched),
      matchMode: String(e?.matchMode ?? "none"),
    });
  }
  return out;
}

function buildIndoorIndex(unitsJson, sheet22, storeSkuMap) {
  const bySku = new Map();
  const byBrandBtu = new Map();

  const indoorFromJson = Array.isArray(unitsJson?.indoorMapping)
    ? unitsJson.indoorMapping
    : [];

  for (const r of indoorFromJson) {
    const sku = String(r["SKU"] ?? "").trim();
    const brand = normBrand(r["Brand"]);
    const btu = asInt(r["BTU"]);
    if (!sku) continue;

    const storeMatch = storeSkuMap.get(sku);
    const csvProductId = nullIfEmpty(r["Product ID"]);
    const csvUrl = nullIfEmpty(r["URL"]);
    const row = {
      brand,
      series: String(r["Series"] ?? "").trim(),
      system: String(r["System"] ?? "").trim(),
      btu,
      sku,
      productId: storeMatch?.productId ?? csvProductId,
      variantId: storeMatch?.variantId ?? null,
      refrigerant: String(r["Refrigerant"] ?? "").trim(),
      url: storeMatch?.productUrl ?? csvUrl,
    };
    bySku.set(sku, row);

    if (btu != null) {
      const key = `${brand}::${btu}`;
      const list = byBrandBtu.get(key) ?? [];
      list.push(row);
      byBrandBtu.set(key, list);
    }
  }

  for (const r of sheet22) {
    const sku = String(r["SKU"] ?? "").trim();
    if (!sku || bySku.has(sku)) continue;
    const brand = normBrand(r["Brand"]);
    const btu = asInt(r["BTU"]);
    const storeMatch = storeSkuMap.get(sku);
    const row = {
      brand,
      series: String(r["Series"] ?? "").trim(),
      system: String(r["System"] ?? "").trim(),
      btu,
      sku,
      productId: storeMatch?.productId ?? null,
      variantId: storeMatch?.variantId ?? null,
      refrigerant: String(r["Refrigerant"] ?? "").trim(),
      url: storeMatch?.productUrl ?? null,
    };
    bySku.set(sku, row);
    if (btu != null) {
      const key = `${brand}::${btu}`;
      const list = byBrandBtu.get(key) ?? [];
      list.push(row);
      byBrandBtu.set(key, list);
    }
  }

  return { bySku, byBrandBtu };
}

function btuUnitsFromCombo(row) {
  const btus = [];
  for (let i = 1; i <= 6; i += 1) {
    const v = asInt(row[`Unit ${i}`]);
    if (v != null && v > 0) btus.push(v);
  }
  return btus;
}

function buildCatalog({ sheet23Rows, sheet22Rows, unitsJson, skuMapJson, sources }) {
  const storeSkuMap = loadSkuMap(skuMapJson);
  const { bySku, byBrandBtu } = buildIndoorIndex(unitsJson, sheet22Rows, storeSkuMap);
  const combos = [];
  const comboKeys = new Set();
  const brandZoneBounds = new Map();

  for (const r of sheet23Rows) {
    const brand = normBrand(r["Brand"]);
    const tier = String(r["Standard/Hyper"] ?? "").trim();
    const refrigerant = String(r["Refrigerant"] ?? "").trim();
    const zones = asInt(r["Number of Zones"]);
    const outdoorSku = String(r["Condenser"] ?? "").trim();
    const outdoorStoreMatch = storeSkuMap.get(outdoorSku);
    const outdoorProductId = nullIfEmpty(r["Outdoor ID"]);
    const outdoorUrl = nullIfEmpty(r["Outdoor URL"]);
    const btuUnits = btuUnitsFromCombo(r).sort((a, b) => a - b);
    if (!brand || !zones || btuUnits.length === 0 || !outdoorSku) continue;

    const key = [
      brand,
      tier,
      refrigerant,
      String(zones),
      outdoorSku,
      btuUnits.join("-"),
    ].join("|");
    if (comboKeys.has(key)) continue;
    comboKeys.add(key);

    const indoorCandidates = [];
    for (const btu of btuUnits) {
      const cands = byBrandBtu.get(`${brand}::${btu}`) ?? [];
      indoorCandidates.push({
        btu,
        candidateSkus: [...new Set(cands.map((c) => c.sku))],
      });
    }

    combos.push({
      comboId: `combo_${comboKeys.size}`,
      brand,
      tier,
      refrigerant,
      zones,
      indoorBtuMultiset: btuUnits,
      indoorSlots: indoorCandidates,
      outdoor: {
        sku: outdoorSku,
        productId: outdoorStoreMatch?.productId ?? outdoorProductId,
        variantId: outdoorStoreMatch?.variantId ?? null,
        url: outdoorStoreMatch?.productUrl ?? outdoorUrl,
      },
      stackGroup: `${brand}:${tier || "any"}:${zones}`,
    });

    const z = brandZoneBounds.get(brand) ?? { min: zones, max: zones };
    z.min = Math.min(z.min, zones);
    z.max = Math.max(z.max, zones);
    brandZoneBounds.set(brand, z);
  }

  const brands = [...new Set(combos.map((c) => c.brand))].sort();
  const zones = [...new Set(combos.map((c) => c.zones))].sort((a, b) => a - b);
  const stats = {
    combos: combos.length,
    brands: brands.length,
    indoorRows: sheet22Rows.length,
    mappedIndoorSkus: [...bySku.values()].filter((r) => r.productId).length,
    sourceRows: sheet23Rows.length,
    mappedOutdoors: combos.filter((c) => c.outdoor.productId).length,
    zones,
    brandZoneBounds: Object.fromEntries(
      [...brandZoneBounds.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    ),
  };

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sources,
    stats,
    brands,
    combos,
  };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function main() {
  const args = parseArgs(process.argv);
  const sheet23 = args.sheet23;
  const sheet22 = args.sheet22;
  const units = args.units;
  const skuMap = args["sku-map"];
  const out = args.out ?? "app/data/hvac/hvac-bundle-catalog.json";

  if (!sheet23 || !sheet22) {
    console.error(
      "Usage: node scripts/build-hvac-catalog.mjs --sheet23 <csv> --sheet22 <csv> [--sku-map <json>] [--units <json>] [--out <json>]",
    );
    process.exit(1);
  }

  const sheet23Rows = parseCsv(fs.readFileSync(sheet23, "utf8"));
  const sheet22Rows = parseCsv(fs.readFileSync(sheet22, "utf8"));
  const unitsJson = units ? JSON.parse(fs.readFileSync(units, "utf8")) : null;
  const skuMapJson = skuMap ? JSON.parse(fs.readFileSync(skuMap, "utf8")) : null;

  const catalog = buildCatalog({
    sheet23Rows,
    sheet22Rows,
    unitsJson,
    skuMapJson,
    sources: {
      sheet23: path.resolve(sheet23),
      sheet22: path.resolve(sheet22),
      units: units ? path.resolve(units) : null,
      skuMap: skuMap ? path.resolve(skuMap) : null,
    },
  });

  ensureDir(path.dirname(out));
  fs.writeFileSync(out, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  console.log(`Wrote ${out}`);
  console.log(JSON.stringify(catalog.stats, null, 2));
}

main();
