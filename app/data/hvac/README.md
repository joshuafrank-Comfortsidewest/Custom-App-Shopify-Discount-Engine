# HVAC Bundle Catalog

Generated file:
- `hvac-bundle-catalog.json`

Schema:
- `hvac-bundle-catalog.schema.json`

Generate/rebuild:

```bash
npm run hvac:build-catalog -- --sheet23 "<path-to-sheet23.csv>" --sheet22 "<path-to-sheet22.csv>" --sku-map "app/data/hvac/hvac-sku-map.json" --out "app/data/hvac/hvac-bundle-catalog.json"
```

`units.json` is optional and should be omitted for new-store setup.

Initial setup (match CSV SKUs to current store):

Recommended UI flow:

1. Open `/app/hvac-mapping` in your embedded app.
2. Upload Sheet22 + Sheet23.
3. Run `Auto-match all unmapped`, manually fix any unmatched rows.
4. Click `Export JSON for catalog build`.
5. Build catalog with that exported file.

CLI alternative:

1. Create SKU map from store:

```bash
$env:SHOPIFY_SHOP="your-store.myshopify.com"
$env:SHOPIFY_ADMIN_ACCESS_TOKEN="shpat_xxx"
npm run hvac:match-store-skus -- --sheet22 "C:\Users\Gaming OS\Downloads\MULTIZONE AUTOMATION - Sheet22.csv" --sheet23 "C:\Users\Gaming OS\Downloads\MULTIZONE AUTOMATION - Sheet23.csv" --out "app/data/hvac/hvac-sku-map.json"
```

2. Build catalog using that map:

```bash
npm run hvac:build-catalog -- --sheet23 "C:\Users\Gaming OS\Downloads\MULTIZONE AUTOMATION - Sheet23.csv" --sheet22 "C:\Users\Gaming OS\Downloads\MULTIZONE AUTOMATION - Sheet22.csv" --sku-map "app/data/hvac/hvac-sku-map.json" --out "app/data/hvac/hvac-bundle-catalog.json"
```

This dataset is still not wired into live discount runtime yet.

Phase 2 (still isolated from live runtime):

- Rules schema: `hvac-discount-rules.schema.json`
- Example rules: `examples/hvac-discount-rules.example.json`
- Example cart: `examples/hvac-cart.example.json`
- Evaluator script: `scripts/evaluate-hvac-bundles.mjs`

Run evaluator:

```bash
npm run hvac:evaluate-bundles -- --catalog "app/data/hvac/hvac-bundle-catalog.json" --rules "app/data/hvac/examples/hvac-discount-rules.example.json" --cart "app/data/hvac/examples/hvac-cart.example.json" --out "app/data/hvac/examples/hvac-evaluation-output.json"
```

The evaluator returns:
- `selectedApplications`: discounts kept after stackability resolution
- `rejectedApplications`: discounts removed due to group/global exclusivity
- `summary.estimatedTotalDiscount`: quick estimate for rule tuning
