use super::schema;
use crate::schema::cart_lines_discounts_generate_run::input::cart::lines::Merchandise;
use serde::Deserialize;
use shopify_function::prelude::*;
use shopify_function::Result;
use std::collections::HashMap;

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
    first_order_enabled: bool,
    bulk_enabled: bool,
    vip_enabled: bool,
    item_collection_enabled: bool,
    collection_spend_enabled: bool,
    hvac_enabled: bool,
}

impl Default for DiscountToggles {
    fn default() -> Self {
        Self {
            first_order_enabled: true,
            bulk_enabled: true,
            vip_enabled: true,
            item_collection_enabled: true,
            collection_spend_enabled: true,
            hvac_enabled: false,
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
struct HvacConfigOverlay {
    combination_rules: Vec<HvacCombinationRuleConfig>,
}

impl Default for HvacConfigOverlay {
    fn default() -> Self {
        Self { combination_rules: vec![] }
    }
}

#[derive(Debug, Deserialize)]
#[serde(default)]
struct SpendActivation {
    mode: String, // "always" | "requires_any"
    required_any: Vec<String>, // ["bulk", "vip", "first"]
}

impl Default for SpendActivation {
    fn default() -> Self {
        Self { mode: "always".to_string(), required_any: vec![] }
    }
}

#[derive(Debug, Deserialize)]
#[serde(default)]
struct CollectionSpendRule {
    enabled: bool,
    amount_off_per_step: f64,
    min_collection_qty: i32,
    spend_step_amount: f64,
    max_discounted_units_per_order: i32,
    product_ids: Vec<String>,
    activation: SpendActivation,
}

impl Default for CollectionSpendRule {
    fn default() -> Self {
        Self {
            enabled: false,
            amount_off_per_step: 0.0,
            min_collection_qty: 1,
            spend_step_amount: 0.0,
            max_discounted_units_per_order: 0,
            product_ids: vec![],
            activation: SpendActivation::default(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(default)]
struct RuntimeConfig {
    toggles: DiscountToggles,
    first_order_percent: f64,
    bulk5_min: i32,
    bulk10_min: i32,
    bulk13_min: i32,
    bulk15_min: i32,
    bulk5_percent: f64,
    bulk10_percent: f64,
    bulk13_percent: f64,
    bulk15_percent: f64,
    hvac_rule: HvacRuleConfig,
    collection_spend_rule: CollectionSpendRule,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            toggles: DiscountToggles::default(),
            first_order_percent: 0.0,
            bulk5_min: 0,
            bulk10_min: 0,
            bulk13_min: 0,
            bulk15_min: 0,
            bulk5_percent: 0.0,
            bulk10_percent: 0.0,
            bulk13_percent: 0.0,
            bulk15_percent: 0.0,
            hvac_rule: HvacRuleConfig::default(),
            collection_spend_rule: CollectionSpendRule::default(),
        }
    }
}

// ── Main function ───────────────────────────────────────────────────────────

#[shopify_function]
fn cart_lines_discounts_generate_run(
    input: schema::cart_lines_discounts_generate_run::Input,
) -> Result<schema::CartLinesDiscountsGenerateRunResult> {
    // Read main config from shop metafield (small — toggles, bulk tiers, spend rule)
    let config_json = input
        .shop()
        .runtime_config()
        .map(|m| m.value().to_string());

    let mut config = config_json
        .as_deref()
        .and_then(parse_runtime_config)
        .unwrap_or_default();

    // HVAC combo rules are stored in a separate metafield to keep main config < 10KB.
    // Overlay them now if HVAC is enabled.
    if config.toggles.hvac_enabled {
        if let Some(hvac_value) = input.shop().hvac_config().map(|m| m.value()) {
            if let Ok(overlay) = serde_json::from_str::<HvacConfigOverlay>(hvac_value) {
                config.hvac_rule.combination_rules = overlay.combination_rules;
            }
        }
    }

    log!(
        "[SDE] config_loaded={} toggles: item={} bulk={} first={} vip={} hvac={}",
        config_json.is_some(),
        config.toggles.item_collection_enabled,
        config.toggles.bulk_enabled,
        config.toggles.first_order_enabled,
        config.toggles.vip_enabled,
        config.toggles.hvac_enabled,
    );
    log!(
        "[SDE] bulk_tiers: {}={:.1}% {}={:.1}% {}={:.1}% {}={:.1}%",
        config.bulk5_min, config.bulk5_percent,
        config.bulk10_min, config.bulk10_percent,
        config.bulk13_min, config.bulk13_percent,
        config.bulk15_min, config.bulk15_percent,
    );

    let (first_order_percent, vip_percent) = compute_customer_percents(&input, &config);
    let hvac_active_rules = active_hvac_rules(&input, &config);
    let cart_subtotal: f64 = input
        .cart()
        .lines()
        .iter()
        .map(|line| line.cost().subtotal_amount().amount().0)
        .sum();
    let bulk_percent = compute_bulk_percent(&config, cart_subtotal);
    let discount_source = determine_discount_source(first_order_percent, vip_percent, bulk_percent);

    log!(
        "[SDE] cart_subtotal={:.2} lines={} bulk_pct={:.1} first_pct={:.1} vip_pct={:.1}",
        cart_subtotal,
        input.cart().lines().len(),
        bulk_percent,
        first_order_percent,
        vip_percent,
    );

    let mut candidates: Vec<schema::ProductDiscountCandidate> = vec![];

    // ── Pre-compute spend discount allocation ──────────────────────────────────
    // Build line_id → qty_to_spend_discount BEFORE the per-line loop so that
    // those units are excluded from the percentage candidate. This prevents
    // Shopify's conflict resolution from silently discarding the spend discount.
    let spend = &config.collection_spend_rule;
    let mut spend_qty_by_line: HashMap<String, i32> = HashMap::new();

    if config.toggles.collection_spend_enabled
        && spend.enabled
        && spend.amount_off_per_step > 0.0
        && spend.spend_step_amount > 0.0
        && !spend.product_ids.is_empty()
    {
        let spend_activation_ok = match spend.activation.mode.as_str() {
            "requires_any" => spend.activation.required_any.iter().any(|req| match req.as_str() {
                "bulk" => bulk_percent > 0.0,
                "vip" => vip_percent > 0.0,
                "first" => first_order_percent > 0.0,
                _ => false,
            }),
            _ => true,
        };

        if spend_activation_ok {
            let spend_ids: std::collections::HashSet<String> =
                spend.product_ids.iter().cloned().collect();

            struct SpendLine { line_id: String, qty: i32, unit_price: f64 }
            let mut eligible: Vec<SpendLine> = vec![];
            let mut total_eligible_qty: i32 = 0;

            for line in input.cart().lines().iter() {
                if let Merchandise::ProductVariant(variant) = line.merchandise() {
                    let pid = normalize_product_id(variant.product().id());
                    if spend_ids.contains(&pid) {
                        let qty = *line.quantity();
                        if qty > 0 {
                            let unit_price =
                                line.cost().subtotal_amount().amount().0 / (qty as f64);
                            total_eligible_qty += qty;
                            eligible.push(SpendLine {
                                line_id: line.id().to_string(),
                                qty,
                                unit_price,
                            });
                        }
                    }
                }
            }

            let min_qty = spend.min_collection_qty.max(1);
            if total_eligible_qty >= min_qty && cart_subtotal >= spend.spend_step_amount {
                let steps = (cart_subtotal / spend.spend_step_amount).floor() as i32;
                let mut units_to_discount = steps.min(total_eligible_qty);
                if spend.max_discounted_units_per_order > 0 {
                    units_to_discount =
                        units_to_discount.min(spend.max_discounted_units_per_order);
                }

                if units_to_discount > 0 {
                    eligible.sort_by(|a, b| {
                        b.unit_price
                            .partial_cmp(&a.unit_price)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    });
                    let mut remaining = units_to_discount;
                    for sl in &eligible {
                        if remaining <= 0 { break; }
                        let take = remaining.min(sl.qty);
                        spend_qty_by_line.insert(sl.line_id.clone(), take);
                        remaining -= take;
                    }
                    log!(
                        "[SDE] spend: total_eligible={} steps={} units_discounted={}",
                        total_eligible_qty, steps, units_to_discount
                    );
                }
            }
        }
    }

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

        // Read item discount percent directly from product metafield
        let item_percent = if config.toggles.item_collection_enabled {
            variant
                .product()
                .discount_percent()
                .and_then(|m| parse_metafield_f64(m.value()))
                .unwrap_or(0.0)
        } else {
            0.0
        };

        let base_percent = item_percent
            .max(bulk_percent)
            .max(first_order_percent)
            .max(vip_percent)
            .max(0.0);

        log!(
            "[SDE] line pid={} qty={} subtotal={:.2} item%={:.1} bulk%={:.1} first%={:.1} vip%={:.1} base%={:.1}",
            product_id, line_qty, line_subtotal, item_percent, bulk_percent, first_order_percent, vip_percent, base_percent,
        );

        // ── HVAC discount handling ──────────────────────────────────────────
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
                if rule.stack_mode == "exclusive_best" {
                    hvac_fixed_exclusive_qty += *fixed_on_line;
                    hvac_fixed_exclusive_amount_total +=
                        (*fixed_on_line as f64) * rule.amount_off_outdoor_per_bundle;
                } else {
                    hvac_fixed_stackable_qty += *fixed_on_line;
                    hvac_fixed_stackable_amount_total +=
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
                    fmt_amount(hvac_fixed_per_item_capped),
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
                    fmt_amount(hvac_fixed_per_item),
                    fmt_amount(hvac_percent_candidate),
                    hvac_fixed_stackable_qty_capped
                )
            } else {
                format!(
                    "Bundle discount: ${} off on {} outdoor unit(s)",
                    fmt_amount(hvac_fixed_per_item.min(line_unit_price).max(0.0)),
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
        // Spend-discounted units are excluded from the percentage candidate to avoid conflict.
        let spend_qty_on_line = spend_qty_by_line.get(line.id()).copied().unwrap_or(0);
        let non_hvac_percent_qty = (remaining_qty - hvac_percent_qty - spend_qty_on_line).max(0);

        if hvac_percent_qty > 0 && hvac_percent_candidate > 0.0 {
            candidates.push(schema::ProductDiscountCandidate {
                targets: vec![schema::ProductDiscountCandidateTarget::CartLine(
                    schema::CartLineTarget {
                        id: line.id().clone(),
                        quantity: Some(hvac_percent_qty),
                    },
                )],
                message: Some(format!(
                    "Best {}% (Bundle discount)",
                    fmt_amount(hvac_percent_candidate)
                )),
                value: schema::ProductDiscountCandidateValue::Percentage(schema::Percentage {
                    value: Decimal(hvac_percent_candidate),
                }),
                associated_discount_code: None,
            });
        }

        if base_percent_candidate > 0.0 && non_hvac_percent_qty > 0 {
            // If item_percent drove this line's discount (higher than all customer discounts),
            // show "Current promotion"; otherwise use the customer discount source label.
            let customer_best = vip_percent.max(first_order_percent).max(bulk_percent);
            let line_source = if item_percent > customer_best + 0.001 {
                "current_promotion"
            } else {
                discount_source.as_str()
            };
            let message = match line_source {
                "vip" => format!("Best {}% (VIP discount)", fmt_amount(base_percent_candidate)),
                "first_order" => format!("Best {}% (First Order)", fmt_amount(base_percent_candidate)),
                "bulk" => format!("Best {}% (Bulk discount)", fmt_amount(base_percent_candidate)),
                _ => format!("Best {}% (Current promotion)", fmt_amount(base_percent_candidate)),
            };
            candidates.push(schema::ProductDiscountCandidate {
                targets: vec![schema::ProductDiscountCandidateTarget::CartLine(
                    schema::CartLineTarget {
                        id: line.id().clone(),
                        quantity: Some(non_hvac_percent_qty),
                    },
                )],
                message: Some(message),
                value: schema::ProductDiscountCandidateValue::Percentage(schema::Percentage {
                    value: Decimal(base_percent_candidate),
                }),
                associated_discount_code: None,
            });
        }

        // Spend discount for units allocated in the pre-loop phase.
        // These units are already excluded from non_hvac_percent_qty — no conflict.
        if spend_qty_on_line > 0 {
            let discount = spend.amount_off_per_step.min(line_unit_price).max(0.0);
            if discount > 0.0 {
                candidates.push(schema::ProductDiscountCandidate {
                    targets: vec![schema::ProductDiscountCandidateTarget::CartLine(
                        schema::CartLineTarget {
                            id: line.id().clone(),
                            quantity: Some(spend_qty_on_line),
                        },
                    )],
                    message: Some(format!("${} off (Spend discount)", fmt_amount(discount))),
                    value: schema::ProductDiscountCandidateValue::FixedAmount(
                        schema::ProductDiscountCandidateFixedAmount {
                            amount: Decimal(discount),
                            applies_to_each_item: Some(true),
                        },
                    ),
                    associated_discount_code: None,
                });
            }
        }
    }

    log!("[SDE] candidates={}", candidates.len());

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

// ── HVAC rules ──────────────────────────────────────────────────────────────

fn active_hvac_rules(
    input: &schema::cart_lines_discounts_generate_run::Input,
    config: &RuntimeConfig,
) -> Vec<HvacActiveRule> {
    let has_configured_hvac_rules = !config.hvac_rule.combination_rules.is_empty()
        || (!config.hvac_rule.outdoor_product_ids.is_empty()
            && !config.hvac_rule.indoor_product_ids.is_empty()
            && (config.hvac_rule.percent_off_hvac_products > 0.0
                || config.hvac_rule.amount_off_outdoor_per_bundle > 0.0));

    if !config.hvac_rule.enabled && !config.toggles.hvac_enabled && !has_configured_hvac_rules {
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
        if !rule.enabled {
            continue;
        }

        let outdoor_source_ids = if rule.outdoor_product_ids.is_empty() {
            &config.hvac_rule.outdoor_product_ids
        } else {
            &rule.outdoor_product_ids
        };
        let indoor_source_ids = if rule.indoor_product_ids.is_empty() {
            &config.hvac_rule.indoor_product_ids
        } else {
            &rule.indoor_product_ids
        };

        if indoor_source_ids.is_empty() || outdoor_source_ids.is_empty() {
            continue;
        }

        let outdoor_products: std::collections::HashSet<String> = outdoor_source_ids
            .iter()
            .map(|pid| normalize_product_id(pid))
            .collect();
        let indoor_products: std::collections::HashSet<String> = indoor_source_ids
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

// ── Helper functions ────────────────────────────────────────────────────────

fn compute_customer_percents(
    input: &schema::cart_lines_discounts_generate_run::Input,
    config: &RuntimeConfig,
) -> (f64, f64) {
    let Some(buyer_identity) = input.cart().buyer_identity() else {
        return (0.0, 0.0);
    };
    let Some(customer) = buyer_identity.customer() else {
        return (0.0, 0.0);
    };

    let first_order_percent =
        if config.toggles.first_order_enabled && *customer.number_of_orders() == 0 {
            config.first_order_percent.max(0.0)
        } else {
            0.0
        };

    let vip_percent = if config.toggles.vip_enabled {
        customer
            .vip_tags()
            .iter()
            .filter(|tag_match| *tag_match.has_tag())
            .filter_map(|tag_match| vip_percent_from_tag(tag_match.tag()))
            .fold(0.0, f64::max)
    } else {
        0.0
    };

    (first_order_percent, vip_percent)
}

fn vip_percent_from_tag(tag: &str) -> Option<f64> {
    let normalized = tag.trim().to_ascii_uppercase();
    let suffix = normalized.strip_prefix("VIP")?;
    let value = suffix.parse::<i32>().ok()?;
    if (3..=25).contains(&value) {
        Some(value as f64)
    } else {
        None
    }
}

fn determine_discount_source(
    first_order_percent: f64,
    vip_percent: f64,
    bulk_percent: f64,
) -> String {
    let best = vip_percent.max(first_order_percent).max(bulk_percent);
    if best <= 0.0 {
        return "current_promotion".to_string();
    }
    // Whichever is highest wins; VIP beats ties, then first order, then bulk
    if vip_percent > 0.0 && vip_percent >= best - 0.001 {
        return "vip".to_string();
    }
    if first_order_percent > 0.0 && first_order_percent >= best - 0.001 {
        return "first_order".to_string();
    }
    if bulk_percent > 0.0 {
        return "bulk".to_string();
    }
    "current_promotion".to_string()
}

fn compute_bulk_percent(config: &RuntimeConfig, cart_subtotal: f64) -> f64 {
    if !config.toggles.bulk_enabled || cart_subtotal <= 0.0 {
        return 0.0;
    }

    let tiers = [
        (config.bulk5_min as f64, config.bulk5_percent),
        (config.bulk10_min as f64, config.bulk10_percent),
        (config.bulk13_min as f64, config.bulk13_percent),
        (config.bulk15_min as f64, config.bulk15_percent),
    ];

    let mut best = 0.0;
    for (min_qty, percent) in tiers {
        if min_qty > 0.0 && cart_subtotal >= min_qty && percent > best {
            best = percent;
        }
    }

    best.max(0.0)
}

fn parse_runtime_config(raw: &str) -> Option<RuntimeConfig> {
    serde_json::from_str::<RuntimeConfig>(raw).ok().or_else(|| {
        // Handle double-encoded JSON string
        serde_json::from_str::<String>(raw)
            .ok()
            .and_then(|decoded| serde_json::from_str::<RuntimeConfig>(&decoded).ok())
    })
}

/// Parse metafield value as f64 — handles both bare numbers and JSON strings.
fn parse_metafield_f64(value: &str) -> Option<f64> {
    // Try parsing as a JSON value first (handles quoted strings like "\"10.5\"")
    if let Ok(s) = serde_json::from_str::<String>(value) {
        return s.parse::<f64>().ok();
    }
    // Try direct parse
    value.parse::<f64>().ok()
}

fn normalize_product_id(raw: &str) -> String {
    raw.strip_prefix("gid://shopify/Product/")
        .unwrap_or(raw)
        .to_string()
}

fn fmt_amount(value: f64) -> String {
    if (value - value.round()).abs() < 0.001 {
        format!("{:.0}", value)
    } else {
        format!("{:.2}", value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_runtime_config_object() {
        let parsed = parse_runtime_config(
            r#"{"toggles":{"bulk_enabled":true},"bulk5_min":5000,"bulk5_percent":5}"#,
        );
        let cfg = parsed.unwrap();
        assert_eq!(cfg.bulk5_min, 5000);
        assert_eq!(cfg.bulk5_percent, 5.0);
    }

    #[test]
    fn parse_metafield_f64_works() {
        assert_eq!(parse_metafield_f64("10.5"), Some(10.5));
        assert_eq!(parse_metafield_f64("\"10.51\""), Some(10.51));
        assert_eq!(parse_metafield_f64("7"), Some(7.0));
    }
}
