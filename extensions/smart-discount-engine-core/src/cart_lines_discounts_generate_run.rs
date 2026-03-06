use super::schema;
use crate::schema::cart_lines_discounts_generate_run::input::cart::lines::Merchandise;
use serde::Deserialize;
use shopify_function::prelude::*;
use shopify_function::Result;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Default)]
struct DiscountPercents {
    first_order: f64,
    bulk: f64,
    vip: f64,
}

#[derive(Clone)]
struct HvacActiveRule {
    name: String,
    stack_mode: String,
    percent_off: f64,
    amount_off_outdoor_per_bundle: f64,
    percent_target_qty_by_line: HashMap<String, i32>,
    fixed_target_qty_by_line: HashMap<String, i32>,
    estimated_total_discount: f64,
}

#[derive(Clone)]
struct LineUnit {
    line_id: String,
    qty: i32,
    unit_price: f64,
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
            collection_spend_enabled: false,
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

#[derive(Debug, Deserialize)]
#[serde(default)]
struct CollectionSpendActivation {
    mode: String,
    required_any: Vec<String>,
    xyz_operator: String,
    bulk_state: String,
    vip_state: String,
    first_state: String,
}

impl Default for CollectionSpendActivation {
    fn default() -> Self {
        Self {
            mode: "always".to_string(),
            required_any: vec!["bulk".to_string()],
            xyz_operator: "or".to_string(),
            bulk_state: "any".to_string(),
            vip_state: "any".to_string(),
            first_state: "any".to_string(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(default)]
struct CollectionSpendRuleConfig {
    enabled: bool,
    amount_off_per_step: f64,
    min_collection_qty: f64,
    spend_step_amount: f64,
    max_discounted_units_per_order: f64,
    product_ids: Vec<String>,
    activation: CollectionSpendActivation,
}

impl Default for CollectionSpendRuleConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            amount_off_per_step: 100.0,
            min_collection_qty: 1.0,
            spend_step_amount: 1500.0,
            max_discounted_units_per_order: 0.0,
            product_ids: vec![],
            activation: CollectionSpendActivation::default(),
        }
    }
}

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Deserialize)]
#[serde(default)]
struct HvacCombinationRuleConfig {
    name: String,
    enabled: bool,
    outdoor_source_sku: String,
    min_indoor_per_outdoor: f64,
    max_indoor_per_outdoor: f64,
    indoor_product_ids: Vec<String>,
    percent_off_hvac_products: f64,
    amount_off_outdoor_per_bundle: f64,
    stack_mode: String,
    outdoor_product_ids: Vec<String>,
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

impl Default for HvacCombinationRuleConfig {
    fn default() -> Self {
        Self {
            name: String::new(),
            enabled: true,
            outdoor_source_sku: String::new(),
            min_indoor_per_outdoor: 2.0,
            max_indoor_per_outdoor: 6.0,
            indoor_product_ids: vec![],
            percent_off_hvac_products: 0.0,
            amount_off_outdoor_per_bundle: 0.0,
            stack_mode: "stackable".to_string(),
            outdoor_product_ids: vec![],
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(default)]
struct RuntimeConfig {
    toggles: DiscountToggles,
    first_order_percent: f64,
    bulk5_min: f64,
    bulk10_min: f64,
    bulk13_min: f64,
    bulk15_min: f64,
    bulk5_percent: f64,
    bulk10_percent: f64,
    bulk13_percent: f64,
    bulk15_percent: f64,
    item_collection_rules: Vec<ItemCollectionRuleConfig>,
    collection_spend_rule: CollectionSpendRuleConfig,
    hvac_rule: HvacRuleConfig,
    cart_labels: CartLabelsConfig,
    block_if_any_entered_discount_code: bool,
    return_conflict_enabled: bool,
    return_blocked_codes: Vec<String>,
    // Legacy fields kept for backward compatibility.
    item_collection_5_percent: f64,
    item_collection_10_percent: f64,
    collection_5_product_ids: Vec<String>,
    collection_10_product_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct RuntimeConfigChunkManifest {
    chunked: bool,
    parts: usize,
}

#[derive(Debug, Deserialize)]
#[serde(default)]
struct CartLabelsConfig {
    best_label: String,
    other_label: String,
    hvac_exclusive_label: String,
    hvac_stack_label: String,
}

impl Default for CartLabelsConfig {
    fn default() -> Self {
        Self {
            best_label: "Best".to_string(),
            other_label: "Other discount".to_string(),
            hvac_exclusive_label: "HVAC exclusive".to_string(),
            hvac_stack_label: "HVAC + base".to_string(),
        }
    }
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            toggles: DiscountToggles::default(),
            first_order_percent: 3.0,
            bulk5_min: 5_000.0,
            bulk10_min: 10_000.0,
            bulk13_min: 11_000.0,
            bulk15_min: 50_000.0,
            bulk5_percent: 5.0,
            bulk10_percent: 10.0,
            bulk13_percent: 13.0,
            bulk15_percent: 15.0,
            item_collection_rules: vec![],
            collection_spend_rule: CollectionSpendRuleConfig::default(),
            hvac_rule: HvacRuleConfig::default(),
            cart_labels: CartLabelsConfig::default(),
            block_if_any_entered_discount_code: false,
            return_conflict_enabled: false,
            return_blocked_codes: vec!["RETURN".to_string()],
            item_collection_5_percent: 5.0,
            item_collection_10_percent: 10.0,
            collection_5_product_ids: vec![],
            collection_10_product_ids: vec![],
        }
    }
}

#[shopify_function]
fn cart_lines_discounts_generate_run(
    input: schema::cart_lines_discounts_generate_run::Input,
) -> Result<schema::CartLinesDiscountsGenerateRunResult> {
    let discount = input.discount();
    let app_function_config_metafield_json = input
        .discount()
        .app_function_config_metafield()
        .map(|metafield| metafield.value())
        .map(|value| value.as_str());
    let app_function_config_chunk_values = [
        discount
            .app_function_config_part_1_metafield()
            .map(|metafield| metafield.value())
            .map(|value| value.as_str()),
        discount
            .app_function_config_part_2_metafield()
            .map(|metafield| metafield.value())
            .map(|value| value.as_str()),
        discount
            .app_function_config_part_3_metafield()
            .map(|metafield| metafield.value())
            .map(|value| value.as_str()),
        discount
            .app_function_config_part_4_metafield()
            .map(|metafield| metafield.value())
            .map(|value| value.as_str()),
    ];
    let metafield_json = resolve_runtime_config_json(
        app_function_config_metafield_json,
        &app_function_config_chunk_values,
    );
    let use_tag_item_fallback = metafield_json.is_none();

    let config = runtime_config(metafield_json.as_deref());

    let has_product_discount_class = input
        .discount()
        .discount_classes()
        .contains(&schema::DiscountClass::Product);

    if !has_product_discount_class {
        return Ok(schema::CartLinesDiscountsGenerateRunResult { operations: vec![] });
    }

    let entered_codes: Vec<String> = input
        .entered_discount_codes()
        .iter()
        .map(|code| code.code().to_uppercase())
        .collect();

    let product_item_percents = build_product_item_percents(&config);
    let customer = input
        .cart()
        .buyer_identity()
        .and_then(|identity| identity.customer());
    let hvac_active_rules = active_hvac_rules(&input, &config);

    let mut first_order_percent: f64 = 0.0;
    let mut vip_percent: f64 = 0.0;

    if let Some(customer) = customer {
        if config.toggles.first_order_enabled && *customer.number_of_orders() == 0 {
            first_order_percent = config.first_order_percent.max(0.0);
        }

        if config.toggles.vip_enabled {
            for tag_match in customer.has_tags().iter() {
                if !*tag_match.has_tag() {
                    continue;
                }
                if let Some(percent) = vip_tag_to_percent(tag_match.tag()) {
                    vip_percent = vip_percent.max(percent);
                }
            }
        }
    }

    // Bulk tiers should be based on cart subtotal before item-level percentage rules.
    let adjusted_subtotal_before_hvac = input.cart().cost().subtotal_amount().amount().0;
    let hvac_fixed_total_for_threshold: f64 = hvac_active_rules
        .iter()
        .map(|rule| {
            let qty: i32 = rule.fixed_target_qty_by_line.values().copied().sum();
            (qty as f64) * rule.amount_off_outdoor_per_bundle.max(0.0)
        })
        .sum();
    // Special-case threshold behavior only when HVAC "$ off bundle" is actually active.
    let adjusted_subtotal = if hvac_fixed_total_for_threshold > 0.0 {
        (adjusted_subtotal_before_hvac - hvac_fixed_total_for_threshold).max(0.0)
    } else {
        adjusted_subtotal_before_hvac
    };

    let bulk = if config.toggles.bulk_enabled {
        bulk_percent(adjusted_subtotal, &config)
    } else {
        0.0
    };

    let discount_percents = DiscountPercents {
        first_order: first_order_percent,
        bulk,
        vip: vip_percent,
    };

    let bulk_active = discount_percents.bulk > 0.0;
    let vip_active = discount_percents.vip > 0.0;
    let first_active = discount_percents.first_order > 0.0;

    let collection_spend_products: HashSet<String> = config
        .collection_spend_rule
        .product_ids
        .iter()
        .map(|product_id| normalize_product_id(product_id))
        .collect();
    let requested_other_units = collection_spend_discountable_units(
        &input,
        &config,
        &collection_spend_products,
        &entered_codes,
        bulk_active,
        vip_active,
        first_active,
    );
    // Apply one fixed-unit discount per spend step (e.g. $3000 => 2 units),
    // prioritizing highest-priced eligible units first.
    let other_units_to_allocate = requested_other_units.max(0);
    let mut other_line_units: Vec<LineUnit> = vec![];
    if other_units_to_allocate > 0 {
        for line in input.cart().lines().iter() {
            if let Merchandise::ProductVariant(variant) = line.merchandise() {
                let normalized_pid = normalize_product_id(variant.product().id());
                if !collection_spend_products.contains(&normalized_pid) {
                    continue;
                }
                let qty = *line.quantity();
                if qty <= 0 {
                    continue;
                }
                let subtotal = line.cost().subtotal_amount().amount().0;
                let unit_price = subtotal / (qty as f64);
                other_line_units.push(LineUnit {
                    line_id: line.id().to_string(),
                    qty,
                    unit_price,
                });
            }
        }
    }
    let (selected_other_units_by_line, _) =
        allocate_high_value_units(&other_line_units, other_units_to_allocate);
    let order_level_percent = discount_percents
        .first_order
        .max(discount_percents.bulk)
        .max(discount_percents.vip);

    let mut candidates: Vec<schema::ProductDiscountCandidate> = vec![];

    for line in input.cart().lines().iter() {
        let mut item_percent: f64 = 0.0;
        let line_qty: i32 = *line.quantity();
        let mut fixed_qty: i32 = 0;
        let mut hvac_fixed_stackable_qty: i32 = 0;
        let mut hvac_fixed_stackable_amount_total: f64 = 0.0;
        let mut hvac_fixed_exclusive_qty: i32 = 0;
        let mut hvac_fixed_exclusive_amount_total: f64 = 0.0;
        let mut hvac_stackable_percent_sum: f64 = 0.0;
        let mut hvac_exclusive_percent_best: f64 = 0.0;
        let mut hvac_percent_units_requested: i32 = 0;
        let fixed_amount_per_item = config.collection_spend_rule.amount_off_per_step.max(0.0);
        let line_id = line.id().to_string();
        let line_subtotal = line.cost().subtotal_amount().amount().0;
        let line_unit_price = if line_qty > 0 {
            line_subtotal / (line_qty as f64)
        } else {
            0.0
        };

        if let Merchandise::ProductVariant(variant) = line.merchandise() {
            let normalized_pid = normalize_product_id(variant.product().id());
            if let Some(percent) = product_item_percents.get(&normalized_pid) {
                item_percent = item_percent.max(*percent);
            }
            if use_tag_item_fallback {
                for tag_match in variant.product().has_tags().iter() {
                    if !*tag_match.has_tag() {
                        continue;
                    }
                    if let Some(percent) = item_off_tag_to_percent(tag_match.tag()) {
                        item_percent = item_percent.max(percent);
                    }
                }
            }
            for rule in hvac_active_rules.iter() {
                let rule_percent_qty = *rule.percent_target_qty_by_line.get(&line_id).unwrap_or(&0);
                if rule_percent_qty > 0 && rule.percent_off > 0.0 {
                    hvac_percent_units_requested = hvac_percent_units_requested.max(rule_percent_qty);
                    if rule.stack_mode == "stackable" {
                        hvac_stackable_percent_sum += rule.percent_off;
                    } else {
                        hvac_exclusive_percent_best = hvac_exclusive_percent_best.max(rule.percent_off);
                    }
                }
                let fixed_on_line = *rule.fixed_target_qty_by_line.get(&line_id).unwrap_or(&0);
                if fixed_on_line > 0 && rule.amount_off_outdoor_per_bundle > 0.0 {
                    if rule.stack_mode == "stackable" {
                        hvac_fixed_stackable_qty += fixed_on_line;
                        hvac_fixed_stackable_amount_total +=
                            (fixed_on_line as f64) * rule.amount_off_outdoor_per_bundle;
                    } else {
                        hvac_fixed_exclusive_qty += fixed_on_line;
                        hvac_fixed_exclusive_amount_total +=
                            (fixed_on_line as f64) * rule.amount_off_outdoor_per_bundle;
                    }
                }
            }
            if collection_spend_products.contains(&normalized_pid) {
                fixed_qty = *selected_other_units_by_line.get(&line_id).unwrap_or(&0);
            }
        }

        let base_percent_candidate = order_level_percent.max(item_percent);
        let current_promo_source = current_promo_attribution(&discount_percents, item_percent);
        if hvac_fixed_exclusive_qty > 0 {
            let hvac_fixed_per_item =
                hvac_fixed_exclusive_amount_total / (hvac_fixed_exclusive_qty as f64);
            let hvac_fixed_per_item_capped = hvac_fixed_per_item.min(line_unit_price).max(0.0);
            candidates.push(schema::ProductDiscountCandidate {
                targets: vec![schema::ProductDiscountCandidateTarget::CartLine(
                    schema::CartLineTarget {
                        id: line.id().clone(),
                        quantity: Some(hvac_fixed_exclusive_qty),
                    },
                )],
                message: Some(format!(
                    "Bundle discount: ${} off on {} outdoor unit(s)",
                    fmt_percent(hvac_fixed_per_item_capped),
                    hvac_fixed_exclusive_qty
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

        if hvac_fixed_stackable_qty > 0 {
            let hvac_fixed_per_item =
                hvac_fixed_stackable_amount_total / (hvac_fixed_stackable_qty as f64);
            let after_hvac_price = (line_unit_price - hvac_fixed_per_item).max(0.0);
            // Apply base percentage after HVAC fixed amount, per requested order:
            // (unit_price - hvac_amount) -> then percentage.
            let stacked_per_item =
                hvac_fixed_per_item + (after_hvac_price * (base_percent_candidate / 100.0));
            let stacked_per_item_capped = stacked_per_item.min(line_unit_price).max(0.0);
            candidates.push(schema::ProductDiscountCandidate {
                targets: vec![schema::ProductDiscountCandidateTarget::CartLine(
                    schema::CartLineTarget {
                        id: line.id().clone(),
                        quantity: Some(hvac_fixed_stackable_qty),
                    },
                )],
                message: Some(format!(
                    "Bundle discount: ${} off + {}% on {} outdoor unit(s)",
                    fmt_percent(hvac_fixed_per_item),
                    fmt_percent(base_percent_candidate),
                    hvac_fixed_stackable_qty
                )),
                value: schema::ProductDiscountCandidateValue::FixedAmount(
                    schema::ProductDiscountCandidateFixedAmount {
                        amount: Decimal(stacked_per_item_capped),
                        applies_to_each_item: Some(true),
                    },
                ),
                associated_discount_code: None,
            });
        }

        let hvac_fixed_qty_total = hvac_fixed_stackable_qty + hvac_fixed_exclusive_qty;
        let remaining_qty: i32 = (line_qty - fixed_qty - hvac_fixed_qty_total).max(0);
        let hvac_percent_qty = remaining_qty.min(hvac_percent_units_requested.max(0));
        let non_hvac_percent_qty = (remaining_qty - hvac_percent_qty).max(0);
        let hvac_stackable_with_base = (base_percent_candidate + hvac_stackable_percent_sum).min(100.0);
        let hvac_exclusive_with_base = base_percent_candidate.max(hvac_exclusive_percent_best);
        let hvac_percent_candidate = hvac_stackable_with_base.max(hvac_exclusive_with_base);
        let bundle_percent_contributed = hvac_percent_candidate > (base_percent_candidate + 0.0001);
        let hvac_percent_attribution = if bundle_percent_contributed && base_percent_candidate > 0.0 {
            format!("{} + Bundle discount", current_promo_source)
        } else if bundle_percent_contributed {
            "Bundle discount".to_string()
        } else {
            current_promo_source.clone()
        };

        if fixed_qty > 0 && fixed_amount_per_item > 0.0 {
            candidates.push(schema::ProductDiscountCandidate {
                targets: vec![schema::ProductDiscountCandidateTarget::CartLine(
                    schema::CartLineTarget {
                        id: line.id().clone(),
                        quantity: Some(fixed_qty),
                    },
                )],
                message: Some(format!(
                    "Accessories discount: ${} off on {} item(s)",
                    fmt_percent(fixed_amount_per_item),
                    fixed_qty
                )),
                value: schema::ProductDiscountCandidateValue::FixedAmount(
                    schema::ProductDiscountCandidateFixedAmount {
                        amount: Decimal(fixed_amount_per_item),
                        applies_to_each_item: Some(true),
                    },
                ),
                associated_discount_code: None,
            });
        }

        if hvac_percent_qty > 0 {
            if hvac_percent_candidate > 0.0 {
                candidates.push(schema::ProductDiscountCandidate {
                    targets: vec![schema::ProductDiscountCandidateTarget::CartLine(
                        schema::CartLineTarget {
                            id: line.id().clone(),
                            quantity: Some(hvac_percent_qty),
                        },
                    )],
                    message: Some(format!(
                        "{} {}% ({})",
                        config.cart_labels.best_label,
                        fmt_percent(hvac_percent_candidate),
                        hvac_percent_attribution
                    )),
                    value: schema::ProductDiscountCandidateValue::Percentage(schema::Percentage {
                        value: Decimal(hvac_percent_candidate),
                    }),
                    associated_discount_code: None,
                });
            }
        }

        if base_percent_candidate > 0.0 && non_hvac_percent_qty > 0 {
            candidates.push(schema::ProductDiscountCandidate {
                targets: vec![schema::ProductDiscountCandidateTarget::CartLine(
                    schema::CartLineTarget {
                        id: line.id().clone(),
                        quantity: Some(non_hvac_percent_qty),
                    },
                )],
                message: Some(format!(
                    "{} {}% ({})",
                    config.cart_labels.best_label,
                    fmt_percent(base_percent_candidate),
                    current_promo_source
                )),
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

fn collection_spend_discountable_units(
    input: &schema::cart_lines_discounts_generate_run::Input,
    config: &RuntimeConfig,
    product_set: &HashSet<String>,
    entered_codes: &[String],
    bulk_active: bool,
    vip_active: bool,
    first_active: bool,
) -> i32 {
    // Only require the dedicated rule toggle; do not depend on top UI toggle.
    if !config.collection_spend_rule.enabled {
        return 0;
    }

    let rule = &config.collection_spend_rule;
    if !activation_matches(
        &rule.activation,
        entered_codes,
        bulk_active,
        vip_active,
        first_active,
    ) {
        return 0;
    }

    let mut qty: f64 = 0.0;
    for line in input.cart().lines().iter() {
        if let Merchandise::ProductVariant(variant) = line.merchandise() {
            let normalized_pid = normalize_product_id(variant.product().id());
            if product_set.contains(&normalized_pid) {
                qty += *line.quantity() as f64;
            }
        }
    }

    let cart_subtotal = input.cart().cost().subtotal_amount().amount().0;
    compute_collection_spend_units(
        cart_subtotal,
        qty,
        rule.min_collection_qty,
        rule.spend_step_amount,
        rule.amount_off_per_step,
        rule.max_discounted_units_per_order,
    )
}

fn compute_collection_spend_units(
    cart_subtotal: f64,
    eligible_qty: f64,
    min_collection_qty: f64,
    spend_step_amount: f64,
    amount_off_per_step: f64,
    max_discounted_units_per_order: f64,
) -> i32 {
    if amount_off_per_step <= 0.0 {
        return 0;
    }
    let spend_step = spend_step_amount.max(0.01);
    let min_qty = min_collection_qty.max(1.0);
    if eligible_qty < min_qty || cart_subtotal < spend_step {
        return 0;
    }

    let steps = (cart_subtotal / spend_step).floor() as i32;
    let eligible_units = eligible_qty.floor() as i32;
    let computed_units = steps.min(eligible_units).max(0);
    let max_units = if max_discounted_units_per_order > 0.0 {
        max_discounted_units_per_order.floor() as i32
    } else {
        i32::MAX
    };
    computed_units.min(max_units).max(0)
}

fn active_hvac_rules(
    input: &schema::cart_lines_discounts_generate_run::Input,
    config: &RuntimeConfig,
) -> Vec<HvacActiveRule> {
    if !config.hvac_rule.enabled {
        return vec![];
    }

    let mut lines_by_product: HashMap<String, Vec<LineUnit>> = HashMap::new();

    for line in input.cart().lines().iter() {
        if let Merchandise::ProductVariant(variant) = line.merchandise() {
            let pid = normalize_product_id(variant.product().id());
            let qty = *line.quantity();
            if qty <= 0 {
                continue;
            }
            let subtotal = line.cost().subtotal_amount().amount().0;
            let unit_price = if qty > 0 { subtotal / (qty as f64) } else { 0.0 };
            let entry = lines_by_product.entry(pid).or_default();
            entry.push(LineUnit {
                line_id: line.id().to_string(),
                qty,
                unit_price,
            });
        }
    }

    let mut candidate_rules: Vec<HvacActiveRule> = vec![];
    for rule in config.hvac_rule.combination_rules.iter() {
        if !rule.enabled || rule.outdoor_product_ids.is_empty() || rule.indoor_product_ids.is_empty() {
            continue;
        }
        let outdoor_products: HashSet<String> = rule
            .outdoor_product_ids
            .iter()
            .map(|product_id| normalize_product_id(product_id))
            .collect();
        let indoor_products: HashSet<String> = rule
            .indoor_product_ids
            .iter()
            .map(|product_id| normalize_product_id(product_id))
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
        // Partial-by-complete-bundle: count only complete bundles.
        let bundle_count = outdoor_qty.min((indoor_qty / min_heads).max(0)).max(0);
        if bundle_count <= 0 {
            continue;
        }
        let max_discountable_indoor = (bundle_count * max_heads).max(0);
        let fixed_units = bundle_count;

        // Maximize customer savings by selecting highest-priced eligible units.
        let (selected_outdoor_qty_by_line, selected_outdoor_subtotal) =
            allocate_high_value_units(&outdoor_line_units, fixed_units);
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

        let percent = rule.percent_off_hvac_products.max(0.0);
        let amount = rule.amount_off_outdoor_per_bundle.max(0.0);
        let percent_subtotal = selected_outdoor_subtotal + selected_indoor_subtotal;
        let est = (percent_subtotal * (percent / 100.0)) + ((fixed_units as f64) * amount);
        candidate_rules.push(HvacActiveRule {
            name: rule.name.clone(),
            stack_mode: rule.stack_mode.clone(),
            percent_off: percent,
            amount_off_outdoor_per_bundle: amount,
            percent_target_qty_by_line: percent_targets,
            fixed_target_qty_by_line: selected_outdoor_qty_by_line,
            estimated_total_discount: est,
        });
    }

    let mut active = vec![];
    let mut exclusive: Vec<HvacActiveRule> = candidate_rules
        .iter()
        .filter(|r| r.stack_mode == "exclusive_best")
        .cloned()
        .collect();
    active.extend(
        candidate_rules
            .into_iter()
            .filter(|r| r.stack_mode != "exclusive_best"),
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

fn allocate_high_value_units(
    units: &[LineUnit],
    target_qty: i32,
) -> (HashMap<String, i32>, f64) {
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
    for u in sorted.iter() {
        if remaining <= 0 {
            break;
        }
        let take = u.qty.min(remaining);
        if take <= 0 {
            continue;
        }
        *by_line.entry(u.line_id.clone()).or_insert(0) += take;
        subtotal += (take as f64) * u.unit_price;
        remaining -= take;
    }
    (by_line, subtotal)
}

fn activation_matches(
    activation: &CollectionSpendActivation,
    entered_codes: &[String],
    bulk_active: bool,
    vip_active: bool,
    first_active: bool,
) -> bool {
    match activation.mode.as_str() {
        "no_other_discounts" => entered_codes.is_empty(),
        "requires_any_xyz_active" => activation.required_any.iter().any(|v| match v.as_str() {
            "bulk" => bulk_active,
            "vip" => vip_active,
            "first" => first_active,
            _ => false,
        }),
        "requires_xyz_state" => {
            let checks = vec![
                state_match(&activation.bulk_state, bulk_active),
                state_match(&activation.vip_state, vip_active),
                state_match(&activation.first_state, first_active),
            ];
            if activation.xyz_operator == "and" {
                checks.into_iter().all(|v| v)
            } else {
                checks.into_iter().any(|v| v)
            }
        }
        _ => true,
    }
}

fn state_match(state: &str, active: bool) -> bool {
    match state {
        "active" => active,
        "inactive" => !active,
        _ => true,
    }
}

fn vip_tag_to_percent(tag: &str) -> Option<f64> {
    if !tag.starts_with("VIP") {
        return None;
    }
    tag[3..]
        .parse::<f64>()
        .ok()
        .filter(|value| (3.0..=15.0).contains(value))
}

fn item_off_tag_to_percent(tag: &str) -> Option<f64> {
    let normalized = tag.trim().to_lowercase();
    if !normalized.ends_with(" off") {
        return None;
    }
    let value = normalized.trim_end_matches(" off").trim().parse::<f64>().ok()?;
    if (0.0..=100.0).contains(&value) {
        Some(value)
    } else {
        None
    }
}

fn bulk_percent(adjusted_subtotal: f64, config: &RuntimeConfig) -> f64 {
    if adjusted_subtotal >= config.bulk15_min {
        config.bulk15_percent
    } else if adjusted_subtotal >= config.bulk13_min {
        config.bulk13_percent
    } else if adjusted_subtotal >= config.bulk10_min {
        config.bulk10_percent
    } else if adjusted_subtotal >= config.bulk5_min {
        config.bulk5_percent
    } else {
        0.0
    }
}

fn runtime_config(raw_json: Option<&str>) -> RuntimeConfig {
    raw_json
        .and_then(|raw| serde_json::from_str::<RuntimeConfig>(raw).ok())
        .unwrap_or_default()
}

fn resolve_runtime_config_json(primary: Option<&str>, chunks: &[Option<&str>]) -> Option<String> {
    if let Some(raw) = primary {
        if let Ok(manifest) = serde_json::from_str::<RuntimeConfigChunkManifest>(raw) {
            if manifest.chunked {
                let mut joined = String::new();
                let parts = manifest.parts.min(chunks.len());
                for idx in 0..parts {
                    if let Some(part) = chunks[idx] {
                        if !part.is_empty() {
                            joined.push_str(part);
                        }
                    }
                }
                return if joined.is_empty() { None } else { Some(joined) };
            }
        }
        if !raw.is_empty() {
            return Some(raw.to_string());
        }
    }

    let mut fallback = String::new();
    for part in chunks.iter().flatten() {
        if !part.is_empty() {
            fallback.push_str(part);
        }
    }
    if fallback.is_empty() {
        None
    } else {
        Some(fallback)
    }
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

fn current_promo_attribution(discount_percents: &DiscountPercents, item_percent: f64) -> String {
    let mut best_source = "None";
    let mut best_percent = 0.0;

    if discount_percents.first_order > best_percent {
        best_percent = discount_percents.first_order;
        best_source = "First";
    }
    if discount_percents.bulk > best_percent {
        best_percent = discount_percents.bulk;
        best_source = "Bulk";
    }
    if discount_percents.vip > best_percent {
        best_percent = discount_percents.vip;
        best_source = "VIP";
    }
    if item_percent > best_percent {
        best_percent = item_percent;
        best_source = "Current Promotion";
    }

    if best_percent <= 0.0 {
        "None".to_string()
    } else {
        format!("{} {}%", best_source, fmt_percent(best_percent))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bulk_percent_uses_highest_matching_tier() {
        let config = RuntimeConfig {
            bulk5_min: 5_000.0,
            bulk10_min: 10_000.0,
            bulk13_min: 11_000.0,
            bulk15_min: 50_000.0,
            bulk5_percent: 5.0,
            bulk10_percent: 10.0,
            bulk13_percent: 13.0,
            bulk15_percent: 15.0,
            ..RuntimeConfig::default()
        };

        assert_eq!(bulk_percent(4_999.99, &config), 0.0);
        assert_eq!(bulk_percent(5_000.0, &config), 5.0);
        assert_eq!(bulk_percent(10_000.0, &config), 10.0);
        assert_eq!(bulk_percent(11_000.0, &config), 13.0);
        assert_eq!(bulk_percent(50_000.0, &config), 15.0);
    }

    #[test]
    fn collection_spend_units_follow_steps_and_qty_cap() {
        assert_eq!(
            compute_collection_spend_units(1_499.0, 10.0, 1.0, 1_500.0, 100.0, 0.0),
            0
        );
        assert_eq!(
            compute_collection_spend_units(3_000.0, 1.0, 1.0, 1_500.0, 100.0, 0.0),
            1
        );
        assert_eq!(
            compute_collection_spend_units(4_500.0, 7.0, 1.0, 1_500.0, 100.0, 0.0),
            3
        );
        assert_eq!(
            compute_collection_spend_units(4_500.0, 7.0, 1.0, 1_500.0, 0.0, 0.0),
            0
        );
        assert_eq!(
            compute_collection_spend_units(15_000.0, 12.0, 1.0, 1_500.0, 100.0, 5.0),
            5
        );
    }

    #[test]
    fn allocate_high_value_units_prefers_expensive_lines() {
        let units = vec![
            LineUnit {
                line_id: "line-a".to_string(),
                qty: 3,
                unit_price: 10.0,
            },
            LineUnit {
                line_id: "line-b".to_string(),
                qty: 2,
                unit_price: 30.0,
            },
            LineUnit {
                line_id: "line-c".to_string(),
                qty: 2,
                unit_price: 20.0,
            },
        ];

        let (by_line, subtotal) = allocate_high_value_units(&units, 3);

        assert_eq!(by_line.get("line-b").copied().unwrap_or(0), 2);
        assert_eq!(by_line.get("line-c").copied().unwrap_or(0), 1);
        assert_eq!(by_line.get("line-a").copied().unwrap_or(0), 0);
        assert!((subtotal - 80.0).abs() < f64::EPSILON);
    }
}
