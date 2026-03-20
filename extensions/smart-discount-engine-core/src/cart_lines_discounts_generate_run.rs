use super::schema;
use crate::schema::cart_lines_discounts_generate_run::input::cart::lines::Merchandise;
use serde::Deserialize;
use shopify_function::prelude::*;
use shopify_function::Result;
use std::collections::{HashMap, HashSet};

#[derive(Clone)]
struct LineUnit {
    line_id: String,
    qty: i32,
    unit_price: f64,
}

#[derive(Clone)]
struct HvacActiveRule {
    stack_mode: String,
    percent_off: f64,
    amount_off_outdoor_per_bundle: f64,
    percent_target_qty_by_line: HashMap<String, i32>,
    fixed_target_qty_by_line: HashMap<String, i32>,
    estimated_total_discount: f64,
}

#[derive(Debug, Deserialize)]
#[serde(default)]
struct DiscountToggles {
    item_collection_enabled: bool,
    hvac_enabled: bool,
}

impl Default for DiscountToggles {
    fn default() -> Self {
        Self {
            item_collection_enabled: true,
            hvac_enabled: false,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(default)]
struct ItemCollectionRuleConfig {
    percent: f64,
    product_ids: Vec<String>,
}

impl Default for ItemCollectionRuleConfig {
    fn default() -> Self {
        Self {
            percent: 0.0,
            product_ids: vec![],
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
struct HvacCombinationRuleConfig {
    name: String,
    enabled: bool,
    min_indoor_per_outdoor: f64,
    max_indoor_per_outdoor: f64,
    indoor_product_ids: Vec<String>,
    outdoor_product_ids: Vec<String>,
    percent_off_hvac_products: f64,
    amount_off_outdoor_per_bundle: f64,
    stack_mode: String,
}

impl Default for HvacCombinationRuleConfig {
    fn default() -> Self {
        Self {
            name: String::new(),
            enabled: true,
            min_indoor_per_outdoor: 2.0,
            max_indoor_per_outdoor: 6.0,
            indoor_product_ids: vec![],
            outdoor_product_ids: vec![],
            percent_off_hvac_products: 0.0,
            amount_off_outdoor_per_bundle: 0.0,
            stack_mode: "stackable".to_string(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default)]
struct HvacRuleConfig {
    enabled: bool,
    min_indoor_per_outdoor: f64,
    max_indoor_per_outdoor: f64,
    percent_off_hvac_products: f64,
    amount_off_outdoor_per_bundle: f64,
    indoor_product_ids: Vec<String>,
    outdoor_product_ids: Vec<String>,
    combination_rules: Vec<HvacCombinationRuleConfig>,
}

impl Default for HvacRuleConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            min_indoor_per_outdoor: 2.0,
            max_indoor_per_outdoor: 6.0,
            percent_off_hvac_products: 0.0,
            amount_off_outdoor_per_bundle: 0.0,
            indoor_product_ids: vec![],
            outdoor_product_ids: vec![],
            combination_rules: vec![],
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(default)]
struct RuntimeConfig {
    toggles: DiscountToggles,
    item_collection_rules: Vec<ItemCollectionRuleConfig>,
    hvac_rule: HvacRuleConfig,

    // Legacy fallback fields.
    item_collection_5_percent: f64,
    item_collection_10_percent: f64,
    collection_5_product_ids: Vec<String>,
    collection_10_product_ids: Vec<String>,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            toggles: DiscountToggles::default(),
            item_collection_rules: vec![],
            hvac_rule: HvacRuleConfig::default(),
            item_collection_5_percent: 5.0,
            item_collection_10_percent: 10.0,
            collection_5_product_ids: vec![],
            collection_10_product_ids: vec![],
        }
    }
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct RuntimeConfigChunkManifest {
    chunked: bool,
    parts: usize,
}

#[shopify_function]
fn cart_lines_discounts_generate_run(
    input: schema::cart_lines_discounts_generate_run::Input,
) -> Result<schema::CartLinesDiscountsGenerateRunResult> {
    let shop = input.shop();
    let runtime_config_primary = shop.runtime_config().map(|metafield| metafield.value().to_string());
    let runtime_config_chunks = [
        shop.runtime_config_part_1()
            .map(|metafield| metafield.value())
            .map(|value| value.as_str()),
        shop.runtime_config_part_2()
            .map(|metafield| metafield.value())
            .map(|value| value.as_str()),
        shop.runtime_config_part_3()
            .map(|metafield| metafield.value())
            .map(|value| value.as_str()),
        shop.runtime_config_part_4()
            .map(|metafield| metafield.value())
            .map(|value| value.as_str()),
        shop.runtime_config_part_5()
            .map(|metafield| metafield.value())
            .map(|value| value.as_str()),
        shop.runtime_config_part_6()
            .map(|metafield| metafield.value())
            .map(|value| value.as_str()),
    ];

    let runtime_config_json =
        resolve_runtime_config_json(runtime_config_primary.as_deref(), &runtime_config_chunks);
    let config = parse_runtime_config(runtime_config_json.as_deref()).unwrap_or_default();

    let item_percents_by_product = build_product_item_percents(&config);
    let hvac_active_rules = active_hvac_rules(&input, &config);

    let mut candidates: Vec<schema::ProductDiscountCandidate> = vec![];

    for line in input.cart().lines().iter() {
        let Merchandise::ProductVariant(variant) = line.merchandise() else {
            continue;
        };

        let line_qty = *line.quantity();
        if line_qty <= 0 {
            continue;
        }

        let line_subtotal = line.cost().subtotal_amount().amount().0;
        let line_unit_price = if line_qty > 0 {
            line_subtotal / (line_qty as f64)
        } else {
            0.0
        };

        let product_id = normalize_product_id(variant.product().id());
        let base_percent = item_percents_by_product
            .get(&product_id)
            .copied()
            .unwrap_or(0.0)
            .max(0.0);

        let mut hvac_fixed_stackable_qty: i32 = 0;
        let mut hvac_fixed_stackable_amount_total: f64 = 0.0;
        let mut hvac_fixed_exclusive_qty: i32 = 0;
        let mut hvac_fixed_exclusive_amount_total: f64 = 0.0;
        let mut hvac_percent_exclusive_best: f64 = 0.0;
        let mut hvac_percent_units_requested: i32 = 0;

        let line_id_key = line.id().to_string();

        for rule in hvac_active_rules.iter() {
            if let Some(rule_percent_qty) = rule.percent_target_qty_by_line.get(&line_id_key) {
                hvac_percent_units_requested = hvac_percent_units_requested.max(*rule_percent_qty);
                hvac_percent_exclusive_best = hvac_percent_exclusive_best.max(rule.percent_off);
            }
            if let Some(fixed_on_line) = rule.fixed_target_qty_by_line.get(&line_id_key) {
                if *fixed_on_line <= 0 {
                    continue;
                }
                if rule.stack_mode == "stackable" {
                    hvac_fixed_stackable_qty += *fixed_on_line;
                    hvac_fixed_stackable_amount_total +=
                        (*fixed_on_line as f64) * rule.amount_off_outdoor_per_bundle;
                } else {
                    hvac_fixed_exclusive_qty += *fixed_on_line;
                    hvac_fixed_exclusive_amount_total +=
                        (*fixed_on_line as f64) * rule.amount_off_outdoor_per_bundle;
                }
            }
        }

        let hvac_fixed_exclusive_qty_capped = hvac_fixed_exclusive_qty.max(0).min(line_qty.max(0));
        let mut hvac_fixed_stackable_qty_capped = hvac_fixed_stackable_qty.max(0);

        if hvac_fixed_exclusive_qty_capped > 0 {
            hvac_fixed_stackable_qty_capped = 0;
            hvac_fixed_stackable_amount_total = 0.0;
        } else {
            hvac_fixed_stackable_qty_capped = hvac_fixed_stackable_qty_capped.min(line_qty.max(0));
        }

        let base_percent_candidate = base_percent;
        let hvac_percent_candidate = base_percent_candidate.max(hvac_percent_exclusive_best);

        if hvac_fixed_exclusive_qty_capped > 0 {
            let hvac_fixed_per_item =
                hvac_fixed_exclusive_amount_total / (hvac_fixed_exclusive_qty.max(1) as f64);
            let hvac_fixed_per_item_capped = hvac_fixed_per_item.min(line_unit_price).max(0.0);
            candidates.push(schema::ProductDiscountCandidate {
                targets: vec![schema::ProductDiscountCandidateTarget::CartLine(
                    schema::CartLineTarget {
                        id: line.id().clone(),
                        quantity: Some(hvac_fixed_exclusive_qty_capped),
                    },
                )],
                message: Some(format!(
                    "Bundle discount: ${} off on {} outdoor unit(s)",
                    fmt_percent(hvac_fixed_per_item_capped),
                    hvac_fixed_exclusive_qty_capped
                )),
                value: schema::ProductDiscountCandidateValue::FixedAmount(
                    schema::ProductDiscountCandidateFixedAmount {
                        amount: Decimal(hvac_fixed_per_item_capped),
                        applies_to_each_item: Some(true),
                    },
                ),
                associated_discount_code: None,
            });
        }

        if hvac_fixed_stackable_qty_capped > 0 {
            let hvac_fixed_per_item =
                hvac_fixed_stackable_amount_total / (hvac_fixed_stackable_qty.max(1) as f64);
            let after_hvac_price = (line_unit_price - hvac_fixed_per_item).max(0.0);
            let stacked_per_item =
                hvac_fixed_per_item + (after_hvac_price * (hvac_percent_candidate / 100.0));
            let stacked_per_item_capped = stacked_per_item.min(line_unit_price).max(0.0);
            let message = if hvac_percent_candidate > 0.0 {
                format!(
                    "Bundle discount: ${} off + {}% on {} outdoor unit(s)",
                    fmt_percent(hvac_fixed_per_item),
                    fmt_percent(hvac_percent_candidate),
                    hvac_fixed_stackable_qty_capped
                )
            } else {
                format!(
                    "Bundle discount: ${} off on {} outdoor unit(s)",
                    fmt_percent(hvac_fixed_per_item.min(line_unit_price).max(0.0)),
                    hvac_fixed_stackable_qty_capped
                )
            };
            candidates.push(schema::ProductDiscountCandidate {
                targets: vec![schema::ProductDiscountCandidateTarget::CartLine(
                    schema::CartLineTarget {
                        id: line.id().clone(),
                        quantity: Some(hvac_fixed_stackable_qty_capped),
                    },
                )],
                message: Some(message),
                value: schema::ProductDiscountCandidateValue::FixedAmount(
                    schema::ProductDiscountCandidateFixedAmount {
                        amount: Decimal(stacked_per_item_capped),
                        applies_to_each_item: Some(true),
                    },
                ),
                associated_discount_code: None,
            });
        }

        let hvac_fixed_qty_total = hvac_fixed_stackable_qty_capped + hvac_fixed_exclusive_qty_capped;
        let remaining_qty: i32 = (line_qty - hvac_fixed_qty_total).max(0);
        let hvac_percent_qty = remaining_qty.min(hvac_percent_units_requested.max(0));
        let non_hvac_percent_qty = (remaining_qty - hvac_percent_qty).max(0);

        if hvac_percent_qty > 0 && hvac_percent_candidate > 0.0 {
            candidates.push(schema::ProductDiscountCandidate {
                targets: vec![schema::ProductDiscountCandidateTarget::CartLine(
                    schema::CartLineTarget {
                        id: line.id().clone(),
                        quantity: Some(hvac_percent_qty),
                    },
                )],
                message: Some(format!("Best {}% (Bundle discount)", fmt_percent(hvac_percent_candidate))),
                value: schema::ProductDiscountCandidateValue::Percentage(schema::Percentage {
                    value: Decimal(hvac_percent_candidate),
                }),
                associated_discount_code: None,
            });
        }

        if base_percent_candidate > 0.0 && non_hvac_percent_qty > 0 {
            candidates.push(schema::ProductDiscountCandidate {
                targets: vec![schema::ProductDiscountCandidateTarget::CartLine(
                    schema::CartLineTarget {
                        id: line.id().clone(),
                        quantity: Some(non_hvac_percent_qty),
                    },
                )],
                message: Some(format!("Best {}% (Current promotion)", fmt_percent(base_percent_candidate))),
                value: schema::ProductDiscountCandidateValue::Percentage(schema::Percentage {
                    value: Decimal(base_percent_candidate),
                }),
                associated_discount_code: None,
            });
        }
    }

    if candidates.is_empty() {
        return Ok(schema::CartLinesDiscountsGenerateRunResult { operations: vec![] });
    }

    Ok(schema::CartLinesDiscountsGenerateRunResult {
        operations: vec![schema::CartOperation::ProductDiscountsAdd(
            schema::ProductDiscountsAddOperation {
                selection_strategy: schema::ProductDiscountSelectionStrategy::All,
                candidates,
            },
        )],
    })
}

fn active_hvac_rules(
    input: &schema::cart_lines_discounts_generate_run::Input,
    config: &RuntimeConfig,
) -> Vec<HvacActiveRule> {
    if !config.hvac_rule.enabled && !config.toggles.hvac_enabled {
        return vec![];
    }

    let mut lines_by_product: HashMap<String, Vec<LineUnit>> = HashMap::new();

    for line in input.cart().lines().iter() {
        if let Merchandise::ProductVariant(variant) = line.merchandise() {
            let product_id = normalize_product_id(variant.product().id());
            let qty = *line.quantity();
            if qty <= 0 {
                continue;
            }
            let subtotal = line.cost().subtotal_amount().amount().0;
            let unit_price = subtotal / (qty as f64);
            lines_by_product
                .entry(product_id)
                .or_default()
                .push(LineUnit {
                    line_id: line.id().to_string(),
                    qty,
                    unit_price,
                });
        }
    }

    let mut candidate_rules = config.hvac_rule.combination_rules.clone();

    if candidate_rules.is_empty()
        && !config.hvac_rule.outdoor_product_ids.is_empty()
        && !config.hvac_rule.indoor_product_ids.is_empty()
    {
        candidate_rules.push(HvacCombinationRuleConfig {
            name: "Default HVAC Rule".to_string(),
            enabled: true,
            min_indoor_per_outdoor: config.hvac_rule.min_indoor_per_outdoor,
            max_indoor_per_outdoor: config.hvac_rule.max_indoor_per_outdoor,
            indoor_product_ids: config.hvac_rule.indoor_product_ids.clone(),
            outdoor_product_ids: config.hvac_rule.outdoor_product_ids.clone(),
            percent_off_hvac_products: config.hvac_rule.percent_off_hvac_products,
            amount_off_outdoor_per_bundle: config.hvac_rule.amount_off_outdoor_per_bundle,
            stack_mode: "stackable".to_string(),
        });
    }

    let mut evaluated_rules: Vec<HvacActiveRule> = vec![];

    for rule in candidate_rules.iter() {
        if !rule.enabled || rule.indoor_product_ids.is_empty() || rule.outdoor_product_ids.is_empty() {
            continue;
        }

        let outdoor_products: HashSet<String> = rule
            .outdoor_product_ids
            .iter()
            .map(|pid| normalize_product_id(pid))
            .collect();
        let indoor_products: HashSet<String> = rule
            .indoor_product_ids
            .iter()
            .map(|pid| normalize_product_id(pid))
            .collect();

        let mut outdoor_line_units: Vec<LineUnit> = vec![];
        let mut indoor_line_units: Vec<LineUnit> = vec![];

        for pid in outdoor_products.iter() {
            if let Some(lines) = lines_by_product.get(pid) {
                outdoor_line_units.extend(lines.iter().cloned());
            }
        }
        for pid in indoor_products.iter() {
            if let Some(lines) = lines_by_product.get(pid) {
                indoor_line_units.extend(lines.iter().cloned());
            }
        }

        let outdoor_qty: i32 = outdoor_line_units.iter().map(|u| u.qty).sum();
        let indoor_qty: i32 = indoor_line_units.iter().map(|u| u.qty).sum();

        let min_heads = rule.min_indoor_per_outdoor.max(1.0).floor() as i32;
        let max_heads = rule.max_indoor_per_outdoor.max(min_heads as f64).floor() as i32;

        if outdoor_qty <= 0 {
            continue;
        }

        let bundle_count = outdoor_qty.min((indoor_qty / min_heads).max(0));
        if bundle_count <= 0 {
            continue;
        }

        let max_discountable_indoor = (bundle_count * max_heads).max(0);

        let (selected_outdoor_qty_by_line, selected_outdoor_subtotal) =
            allocate_high_value_units(&outdoor_line_units, bundle_count);
        let (selected_indoor_qty_by_line, selected_indoor_subtotal) =
            allocate_high_value_units(&indoor_line_units, max_discountable_indoor);

        let mut percent_targets: HashMap<String, i32> = HashMap::new();
        for (line_id, qty) in selected_outdoor_qty_by_line.iter() {
            if *qty > 0 {
                *percent_targets.entry(line_id.clone()).or_insert(0) += *qty;
            }
        }
        for (line_id, qty) in selected_indoor_qty_by_line.iter() {
            if *qty > 0 {
                *percent_targets.entry(line_id.clone()).or_insert(0) += *qty;
            }
        }

        let percent = rule
            .percent_off_hvac_products
            .max(config.hvac_rule.percent_off_hvac_products)
            .max(0.0);
        let amount = rule
            .amount_off_outdoor_per_bundle
            .max(config.hvac_rule.amount_off_outdoor_per_bundle)
            .max(0.0);

        let percent_subtotal = selected_outdoor_subtotal + selected_indoor_subtotal;
        let estimated_total_discount =
            (percent_subtotal * (percent / 100.0)) + ((bundle_count as f64) * amount);

        let stack_mode = if rule.stack_mode.trim().is_empty() {
            "stackable".to_string()
        } else {
            rule.stack_mode.clone()
        };

        evaluated_rules.push(HvacActiveRule {
            stack_mode,
            percent_off: percent,
            amount_off_outdoor_per_bundle: amount,
            percent_target_qty_by_line: percent_targets,
            fixed_target_qty_by_line: selected_outdoor_qty_by_line,
            estimated_total_discount,
        });
    }

    let mut active = vec![];
    let mut exclusive: Vec<HvacActiveRule> = evaluated_rules
        .iter()
        .filter(|rule| rule.stack_mode == "exclusive_best")
        .cloned()
        .collect();

    active.extend(
        evaluated_rules
            .into_iter()
            .filter(|rule| rule.stack_mode != "exclusive_best"),
    );

    if !exclusive.is_empty() {
        exclusive.sort_by(|a, b| {
            b.estimated_total_discount
                .partial_cmp(&a.estimated_total_discount)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        if let Some(best) = exclusive.into_iter().next() {
            active.push(best);
        }
    }

    active
}

fn allocate_high_value_units(units: &[LineUnit], target_qty: i32) -> (HashMap<String, i32>, f64) {
    if target_qty <= 0 || units.is_empty() {
        return (HashMap::new(), 0.0);
    }

    let mut sorted = units.to_vec();
    sorted.sort_by(|a, b| {
        b.unit_price
            .partial_cmp(&a.unit_price)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut remaining = target_qty;
    let mut by_line: HashMap<String, i32> = HashMap::new();
    let mut subtotal = 0.0;

    for unit in sorted.iter() {
        if remaining <= 0 {
            break;
        }
        let take = unit.qty.min(remaining);
        if take <= 0 {
            continue;
        }
        *by_line.entry(unit.line_id.clone()).or_insert(0) += take;
        subtotal += (take as f64) * unit.unit_price;
        remaining -= take;
    }

    (by_line, subtotal)
}

fn build_product_item_percents(config: &RuntimeConfig) -> HashMap<String, f64> {
    let mut percents: HashMap<String, f64> = HashMap::new();

    if config.toggles.item_collection_enabled && !config.item_collection_rules.is_empty() {
        for rule in config.item_collection_rules.iter() {
            let percent = rule.percent.max(0.0);
            if percent <= 0.0 {
                continue;
            }
            for product_id in rule.product_ids.iter() {
                let normalized_pid = normalize_product_id(product_id);
                let entry = percents.entry(normalized_pid).or_insert(0.0);
                *entry = entry.max(percent);
            }
        }
        return percents;
    }

    let legacy5 = config.item_collection_5_percent.max(0.0);
    if legacy5 > 0.0 {
        for product_id in config.collection_5_product_ids.iter() {
            let normalized_pid = normalize_product_id(product_id);
            let entry = percents.entry(normalized_pid).or_insert(0.0);
            *entry = entry.max(legacy5);
        }
    }

    let legacy10 = config.item_collection_10_percent.max(0.0);
    if legacy10 > 0.0 {
        for product_id in config.collection_10_product_ids.iter() {
            let normalized_pid = normalize_product_id(product_id);
            let entry = percents.entry(normalized_pid).or_insert(0.0);
            *entry = entry.max(legacy10);
        }
    }

    percents
}

fn parse_runtime_config(raw_json: Option<&str>) -> Option<RuntimeConfig> {
    let raw = raw_json?;
    serde_json::from_str::<RuntimeConfig>(raw).ok().or_else(|| {
        serde_json::from_str::<String>(raw)
            .ok()
            .and_then(|decoded| serde_json::from_str::<RuntimeConfig>(&decoded).ok())
    })
}

fn resolve_runtime_config_json(primary: Option<&str>, chunks: &[Option<&str>]) -> Option<String> {
    let decode_json_string = |raw: &str| -> String {
        serde_json::from_str::<String>(raw).unwrap_or_else(|_| raw.to_string())
    };

    let decode_manifest = |raw: &str| -> Option<RuntimeConfigChunkManifest> {
        serde_json::from_str::<RuntimeConfigChunkManifest>(raw).ok().or_else(|| {
            serde_json::from_str::<String>(raw)
                .ok()
                .and_then(|decoded| serde_json::from_str::<RuntimeConfigChunkManifest>(&decoded).ok())
        })
    };

    if let Some(raw) = primary {
        if let Some(manifest) = decode_manifest(raw) {
            if manifest.chunked {
                if manifest.parts == 0 || manifest.parts > chunks.len() {
                    return None;
                }

                let mut joined = String::new();
                for idx in 0..manifest.parts {
                    let Some(part) = chunks[idx] else {
                        return None;
                    };
                    let decoded_part = decode_json_string(part);
                    if decoded_part.is_empty() {
                        return None;
                    }
                    joined.push_str(&decoded_part);
                }
                return Some(joined);
            }
        }

        let decoded_primary = decode_json_string(raw);
        if !decoded_primary.is_empty() {
            return Some(decoded_primary);
        }
    }

    let mut fallback = String::new();
    for part in chunks.iter().flatten() {
        let decoded_part = decode_json_string(part);
        if !decoded_part.is_empty() {
            fallback.push_str(&decoded_part);
        }
    }

    if fallback.is_empty() {
        None
    } else {
        Some(fallback)
    }
}

fn normalize_product_id(raw: &str) -> String {
    raw.strip_prefix("gid://shopify/Product/")
        .unwrap_or(raw)
        .to_string()
}

fn fmt_percent(value: f64) -> String {
    if (value - value.round()).abs() < 0.001 {
        format!("{:.0}", value)
    } else {
        format!("{:.2}", value)
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_runtime_config, resolve_runtime_config_json, RuntimeConfig};

    #[test]
    fn resolves_chunked_runtime_config_manifest() {
        let primary = r#"{"chunked":true,"parts":2}"#;
        let chunks = [Some("{\"item_collection_rules\":["), Some("]}"), None];
        let resolved = resolve_runtime_config_json(Some(primary), &chunks);
        assert_eq!(
            resolved.as_deref(),
            Some("{\"item_collection_rules\":[]}")
        );
    }

    #[test]
    fn parses_runtime_config_object() {
        let parsed = parse_runtime_config(Some("{\"item_collection_rules\":[{\"percent\":17,\"product_ids\":[\"gid://shopify/Product/1\"]}]}"));
        let cfg: RuntimeConfig = parsed.unwrap_or_default();
        assert_eq!(cfg.item_collection_rules.len(), 1);
        assert_eq!(cfg.item_collection_rules[0].percent, 17.0);
    }
}
