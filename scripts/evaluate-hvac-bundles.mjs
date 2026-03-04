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

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function cloneMap(map) {
  return new Map(map);
}

function sumMapValues(map) {
  let out = 0;
  for (const v of map.values()) out += v;
  return out;
}

function flattenLineUnits(lines) {
  const units = [];
  for (const line of lines) {
    const quantity = Math.max(0, toInt(line.quantity, 0));
    for (let i = 0; i < quantity; i += 1) {
      units.push({
        lineId: String(line.lineId ?? ""),
        sku: String(line.sku ?? ""),
        unitPrice: Math.max(0, toNumber(line.unitPrice, 0)),
      });
    }
  }
  return units;
}

function indexCartLines(lines) {
  const bySku = new Map();
  for (const line of lines) {
    const sku = String(line.sku ?? "").trim();
    if (!sku) continue;
    const quantity = Math.max(0, toInt(line.quantity, 0));
    const unitPrice = Math.max(0, toNumber(line.unitPrice, 0));
    const existing = bySku.get(sku) ?? [];
    existing.push({
      lineId: String(line.lineId ?? ""),
      sku,
      quantity,
      unitPrice,
    });
    bySku.set(sku, existing);
  }
  return bySku;
}

function totalQty(lines) {
  let out = 0;
  for (const line of lines) out += Math.max(0, toInt(line.quantity, 0));
  return out;
}

function slotCandidatesWithQty(slot, indoorQtyBySku) {
  const candidates = [];
  for (const sku of slot.candidateSkus ?? []) {
    const qty = indoorQtyBySku.get(sku) ?? 0;
    if (qty > 0) candidates.push(sku);
  }
  return candidates;
}

function pickNextSlot(slots, indoorQtyBySku, assignedSlotIdxSet) {
  let bestIdx = -1;
  let bestCount = Number.POSITIVE_INFINITY;
  for (let i = 0; i < slots.length; i += 1) {
    if (assignedSlotIdxSet.has(i)) continue;
    const count = slotCandidatesWithQty(slots[i], indoorQtyBySku).length;
    if (count < bestCount) {
      bestCount = count;
      bestIdx = i;
    }
  }
  return { slotIdx: bestIdx, viableCount: bestCount };
}

function tryAllocateOneBundle(slots, indoorQtyBySku, assignedBySlot = new Map(), used = new Set()) {
  if (assignedBySlot.size >= slots.length) return assignedBySlot;

  const { slotIdx, viableCount } = pickNextSlot(slots, indoorQtyBySku, used);
  if (slotIdx < 0 || viableCount <= 0) return null;

  const slot = slots[slotIdx];
  const viableSkus = slotCandidatesWithQty(slot, indoorQtyBySku);

  for (const sku of viableSkus) {
    const curQty = indoorQtyBySku.get(sku) ?? 0;
    if (curQty <= 0) continue;

    indoorQtyBySku.set(sku, curQty - 1);
    assignedBySlot.set(slotIdx, sku);
    used.add(slotIdx);

    const result = tryAllocateOneBundle(slots, indoorQtyBySku, assignedBySlot, used);
    if (result) return result;

    indoorQtyBySku.set(sku, curQty);
    assignedBySlot.delete(slotIdx);
    used.delete(slotIdx);
  }

  return null;
}

function matchBundlesForCombo(combo, linesBySku) {
  const outdoorLines = linesBySku.get(combo.outdoor?.sku) ?? [];
  const outdoorQty = totalQty(outdoorLines);
  if (outdoorQty <= 0) {
    return {
      bundlesMatched: 0,
      bundles: [],
    };
  }

  const indoorQtyBySku = new Map();
  const indoorPriceBySku = new Map();
  for (const slot of combo.indoorSlots ?? []) {
    for (const sku of slot.candidateSkus ?? []) {
      if (sku === combo.outdoor?.sku) continue;
      const lines = linesBySku.get(sku) ?? [];
      const qty = totalQty(lines);
      if (qty <= 0) continue;
      indoorQtyBySku.set(sku, qty);
      if (!indoorPriceBySku.has(sku) && lines.length > 0) {
        indoorPriceBySku.set(sku, Math.max(0, toNumber(lines[0].unitPrice, 0)));
      }
    }
  }

  const bundles = [];
  const maxByIndoor = sumMapValues(indoorQtyBySku);
  const hardMax = Math.min(outdoorQty, maxByIndoor);
  for (let i = 0; i < hardMax; i += 1) {
    const draftQty = cloneMap(indoorQtyBySku);
    const assigned = tryAllocateOneBundle(combo.indoorSlots ?? [], draftQty);
    if (!assigned || assigned.size < (combo.indoorSlots ?? []).length) break;

    for (const [sku, qty] of draftQty.entries()) {
      indoorQtyBySku.set(sku, qty);
    }

    const indoorUnits = [];
    for (const sku of assigned.values()) {
      indoorUnits.push({
        sku,
        unitPrice: indoorPriceBySku.get(sku) ?? 0,
      });
    }

    const outdoorPrice = outdoorLines.length > 0 ? Math.max(0, toNumber(outdoorLines[0].unitPrice, 0)) : 0;
    bundles.push({
      indoorUnits,
      outdoor: {
        sku: combo.outdoor.sku,
        unitPrice: outdoorPrice,
      },
    });
  }

  return {
    bundlesMatched: bundles.length,
    bundles,
  };
}

function comboMatchesRule(combo, rule) {
  const when = rule.when ?? {};
  if (Array.isArray(when.brands) && when.brands.length > 0 && !when.brands.includes(combo.brand)) return false;
  if (Array.isArray(when.tiers) && when.tiers.length > 0 && !when.tiers.includes(combo.tier)) return false;
  if (
    Array.isArray(when.refrigerants) &&
    when.refrigerants.length > 0 &&
    !when.refrigerants.includes(combo.refrigerant)
  ) {
    return false;
  }
  if (toInt(when.zoneMin, 0) > 0 && combo.zones < toInt(when.zoneMin, 0)) return false;
  if (toInt(when.zoneMax, 0) > 0 && combo.zones > toInt(when.zoneMax, 0)) return false;
  return true;
}

function ruleApplicationsForBundle(bundle, discountConfig) {
  const mode = String(discountConfig.mode ?? "percent_off");
  const percentOff = Math.max(0, toNumber(discountConfig.percentOff, 0));
  const amountOff = Math.max(0, toNumber(discountConfig.amountOff, 0));
  const amountTarget = String(discountConfig.amountTarget ?? "outdoor");

  const bundleSubtotal =
    bundle.outdoor.unitPrice + bundle.indoorUnits.reduce((s, it) => s + Math.max(0, it.unitPrice), 0);
  const highestIndoor = bundle.indoorUnits.reduce((m, it) => Math.max(m, it.unitPrice), 0);

  let percentDiscount = 0;
  let amountDiscount = 0;

  if (mode === "percent_off" || mode === "combined") {
    percentDiscount = (bundleSubtotal * percentOff) / 100;
  }

  if (mode === "fixed_amount_off_component" || mode === "combined") {
    let cap = 0;
    if (amountTarget === "outdoor") cap = bundle.outdoor.unitPrice;
    else if (amountTarget === "indoor_highest_price") cap = highestIndoor;
    else if (amountTarget === "outdoor_or_indoor_highest") cap = Math.max(bundle.outdoor.unitPrice, highestIndoor);
    else cap = highestIndoor;
    amountDiscount = Math.min(amountOff, Math.max(0, cap));
  }

  return {
    bundleSubtotal,
    percentDiscount,
    amountDiscount,
    totalDiscount: percentDiscount + amountDiscount,
  };
}

function evaluateRules({ catalog, rulesConfig, cart }) {
  const rules = Array.isArray(rulesConfig?.rules) ? rulesConfig.rules : [];
  const lines = Array.isArray(cart?.lines) ? cart.lines : [];
  const linesBySku = indexCartLines(lines);

  const candidates = [];

  for (const combo of catalog.combos ?? []) {
    const match = matchBundlesForCombo(combo, linesBySku);
    if (match.bundlesMatched <= 0) continue;

    for (const rule of rules) {
      if (!rule?.enabled) continue;
      if (!comboMatchesRule(combo, rule)) continue;

      const minBundles = Math.max(1, toInt(rule?.when?.minBundles, 1));
      if (match.bundlesMatched < minBundles) continue;

      const maxApplications = Math.max(1, toInt(rule?.discount?.maxApplicationsPerCart, match.bundlesMatched));
      const applyCount = Math.min(match.bundlesMatched, maxApplications);

      let discountTotal = 0;
      let subtotalCovered = 0;
      for (let i = 0; i < applyCount; i += 1) {
        const b = match.bundles[i];
        const d = ruleApplicationsForBundle(b, rule.discount ?? {});
        discountTotal += d.totalDiscount;
        subtotalCovered += d.bundleSubtotal;
      }

      candidates.push({
        ruleId: String(rule.ruleId),
        ruleName: String(rule.name ?? rule.ruleId),
        comboId: combo.comboId,
        comboRef: {
          brand: combo.brand,
          tier: combo.tier,
          zones: combo.zones,
          refrigerant: combo.refrigerant,
          outdoorSku: combo.outdoor?.sku ?? "",
          stackGroup: combo.stackGroup,
        },
        stackMode: String(rule.stackMode ?? "stackable"),
        stackGroup: String(rule.stackGroup ?? combo.stackGroup ?? "default"),
        bundlesMatched: match.bundlesMatched,
        bundlesDiscounted: applyCount,
        subtotalCovered: Number(subtotalCovered.toFixed(2)),
        estimatedDiscount: Number(discountTotal.toFixed(2)),
        discountConfig: rule.discount ?? {},
      });
    }
  }

  const selected = resolveStacking(candidates);

  const rejectedIds = new Set(selected.rejected.map((r) => r.candidateId));
  const withIds = candidates.map((c, idx) => ({ ...c, candidateId: idx + 1 }));

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      cartLines: lines.length,
      candidateApplications: withIds.length,
      selectedApplications: selected.kept.length,
      estimatedTotalDiscount: Number(
        selected.kept.reduce((s, x) => s + x.estimatedDiscount, 0).toFixed(2),
      ),
    },
    selectedApplications: selected.kept,
    rejectedApplications: selected.rejected,
    allCandidates: withIds.filter((c) => !rejectedIds.has(c.candidateId)),
  };
}

function resolveStacking(candidates) {
  const withIds = candidates.map((c, idx) => ({ ...c, candidateId: idx + 1 }));
  const kept = [];
  const rejected = [];

  const stackable = withIds.filter((c) => c.stackMode === "stackable");
  kept.push(...stackable);

  const grouped = withIds.filter((c) => c.stackMode === "exclusive_group");
  const byGroup = new Map();
  for (const c of grouped) {
    const key = c.stackGroup || "default";
    const list = byGroup.get(key) ?? [];
    list.push(c);
    byGroup.set(key, list);
  }
  for (const [group, list] of byGroup.entries()) {
    list.sort((a, b) => b.estimatedDiscount - a.estimatedDiscount);
    kept.push(list[0]);
    for (let i = 1; i < list.length; i += 1) {
      rejected.push({
        ...list[i],
        reason: `Lost to higher discount in exclusive group '${group}'`,
      });
    }
  }

  const globalExclusive = withIds.filter((c) => c.stackMode === "exclusive_global");
  if (globalExclusive.length > 0) {
    globalExclusive.sort((a, b) => b.estimatedDiscount - a.estimatedDiscount);
    kept.push(globalExclusive[0]);
    for (let i = 1; i < globalExclusive.length; i += 1) {
      rejected.push({
        ...globalExclusive[i],
        reason: "Lost to higher discount in exclusive_global set",
      });
    }
  }

  const keptIds = new Set(kept.map((k) => k.candidateId));
  const remainingRejected = withIds.filter(
    (c) => !keptIds.has(c.candidateId) && !rejected.some((r) => r.candidateId === c.candidateId),
  );
  for (const r of remainingRejected) {
    rejected.push({
      ...r,
      reason: "Not selected",
    });
  }

  kept.sort((a, b) => b.estimatedDiscount - a.estimatedDiscount);
  return { kept, rejected };
}

function usageAndExit() {
  console.error(
    "Usage: node scripts/evaluate-hvac-bundles.mjs --catalog <catalog.json> --rules <rules.json> --cart <cart.json> [--out <result.json>]",
  );
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.catalog || !args.rules || !args.cart) usageAndExit();

  const catalog = JSON.parse(fs.readFileSync(args.catalog, "utf8"));
  const rules = JSON.parse(fs.readFileSync(args.rules, "utf8"));
  const cart = JSON.parse(fs.readFileSync(args.cart, "utf8"));
  const out = args.out
    ? path.resolve(args.out)
    : path.resolve("app/data/hvac/examples/hvac-evaluation-output.json");

  const result = evaluateRules({
    catalog,
    rulesConfig: rules,
    cart,
  });

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, "utf8");

  console.log(`Wrote ${out}`);
  console.log(JSON.stringify(result.summary, null, 2));
}

main();
