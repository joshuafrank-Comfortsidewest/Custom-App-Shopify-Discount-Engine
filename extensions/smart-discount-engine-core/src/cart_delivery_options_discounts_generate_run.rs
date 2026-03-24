use super::schema;
use shopify_function::prelude::*;
use shopify_function::Result;

#[shopify_function]
fn cart_delivery_options_discounts_generate_run(
    input: schema::cart_delivery_options_discounts_generate_run::Input,
) -> Result<schema::CartDeliveryOptionsDiscountsGenerateRunResult> {
    let has_shipping_discount_class = input
        .discount()
        .discount_classes()
        .contains(&schema::DiscountClass::Shipping);

    if !has_shipping_discount_class {
        return Ok(schema::CartDeliveryOptionsDiscountsGenerateRunResult { operations: vec![] });
    }

    // Only apply free shipping when cart subtotal >= $300
    let cart_subtotal = input.cart().cost().subtotal_amount().amount().0;
    if cart_subtotal < 300.0 {
        return Ok(schema::CartDeliveryOptionsDiscountsGenerateRunResult { operations: vec![] });
    }

    let first_delivery_group = input
        .cart()
        .delivery_groups()
        .first()
        .ok_or("No delivery groups found")?;

    // Only apply free shipping to "Delivery with Lift Gate" — never to other methods
    let lift_gate_option = first_delivery_group
        .delivery_options()
        .iter()
        .find(|opt| {
            opt.title()
                .as_deref()
                .map(|t| t.to_lowercase().contains("lift gate"))
                .unwrap_or(false)
        });

    let lift_gate_option = match lift_gate_option {
        Some(opt) => opt,
        None => return Ok(schema::CartDeliveryOptionsDiscountsGenerateRunResult { operations: vec![] }),
    };

    Ok(schema::CartDeliveryOptionsDiscountsGenerateRunResult {
        operations: vec![schema::DeliveryOperation::DeliveryDiscountsAdd(
            schema::DeliveryDiscountsAddOperation {
                selection_strategy: schema::DeliveryDiscountSelectionStrategy::All,
                candidates: vec![schema::DeliveryDiscountCandidate {
                    targets: vec![schema::DeliveryDiscountCandidateTarget::DeliveryOption(
                        schema::DeliveryOptionTarget {
                            handle: lift_gate_option.handle().clone(),
                        },
                    )],
                    value: schema::DeliveryDiscountCandidateValue::Percentage(schema::Percentage {
                        value: Decimal(100.0),
                    }),
                    message: Some("FREE DELIVERY".to_string()),
                    associated_discount_code: None,
                }],
            },
        )],
    })
}
