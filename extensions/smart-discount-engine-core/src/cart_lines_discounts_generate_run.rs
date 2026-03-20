use super::schema;
use shopify_function::prelude::*;
use shopify_function::Result;

#[shopify_function]
fn cart_lines_discounts_generate_run(
    _input: schema::cart_lines_discounts_generate_run::Input,
) -> Result<schema::CartLinesDiscountsGenerateRunResult> {
    // Fresh baseline: no discount operations until v2 logic is implemented.
    Ok(schema::CartLinesDiscountsGenerateRunResult { operations: vec![] })
}
