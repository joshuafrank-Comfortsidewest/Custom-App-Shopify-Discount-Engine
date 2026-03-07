(function () {
  if (window.__cdpWidgetLoaded) return;
  window.__cdpWidgetLoaded = true;

  const MONEY_FORMATTER = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
  const ACCESSORY_HINT_CACHE = {
    tecinfoUrl: null,
    tecinfoMap: null,
    tecinfoLoading: null,
  };

  class CartDiscountWidget {
    constructor(root) {
      this.root = root;
      this.settings = this.readSettings(root.dataset);
      this.latestResponse = null;
      this.expandedRecommendations = false;
      this.selectedRecommendationType = "";
      this.typeFilterPinned = false;
    }

    readSettings(dataset) {
      return {
        endpoint: dataset.endpoint || "/apps/discount-progress/widget-data",
        tiers: dataset.tiers || "100:5,250:10,400:13,600:15",
        maxRecommendations: Number(dataset.maxRecommendations || 2),
        nearThresholdPercent: Number(dataset.nearThresholdPercent || 20),
        recommendationsEnabled:
          dataset.recommendationsEnabled !== undefined
            ? dataset.recommendationsEnabled === "true"
            : true,
        trackingEnabled:
          dataset.trackingEnabled !== undefined
            ? dataset.trackingEnabled === "true"
            : true,
        xyzHintEnabled:
          dataset.xyzHintEnabled !== undefined ? dataset.xyzHintEnabled === "true" : false,
        xyzHintMessage:
          dataset.xyzHintMessage ||
          "Add qualifying collection items to improve your total discount.",
      };
    }

    async refresh() {
      try {
        this.renderLoading();
        const cartResponse = await fetch("/cart.js");
        if (!cartResponse.ok) {
          this.renderError("Could not load cart data.");
          return;
        }
        const cart = await cartResponse.json();
        const cartLines = buildCartLines(cart);
        const accessoryHints = await resolveCartAccessoryHints(cartLines);
        const currentDiscountPercent = getCurrentDiscountPercent(cart);
        const recommendationPoolSize = Math.min(
          18,
          Math.max(this.settings.maxRecommendations * 5, 12),
        );

        const params = new URLSearchParams({
          subtotal: String((cart.items_subtotal_price || 0) / 100),
          currency:
            (window.Shopify && window.Shopify.currency && window.Shopify.currency.active) ||
            "USD",
          tiers: this.settings.tiers,
          maxRecommendations: String(recommendationPoolSize),
          nearThresholdPercent: String(this.settings.nearThresholdPercent),
          recommendationsEnabled: String(this.settings.recommendationsEnabled),
          xyzHintEnabled: String(this.settings.xyzHintEnabled),
          xyzHintMessage: this.settings.xyzHintMessage,
          cartProductIds: cartLines.map((line) => line.productId).join(","),
          cartVariantIds: cartLines.map((line) => line.variantId).join(","),
          cartLines: JSON.stringify(cartLines),
          preferredAccessoryProductIds: accessoryHints.productIds.join(","),
          preferredAccessoryHandles: accessoryHints.handles.join(","),
          accessoryContext: JSON.stringify(
            (accessoryHints.links || []).map((link) => ({
              p: link.productId || "",
              h: link.handle || "",
              s: link.sourceHandle || "",
            })),
          ),
          excludeVariantIds: getFailedVariantIds().join(","),
          currentDiscountPercent: String(currentDiscountPercent),
        });

        const response = await fetch(`${this.settings.endpoint}?${params.toString()}`);
        if (!response.ok) {
          this.renderError("Could not load discount progress.");
          return;
        }
        const payload = await response.json();
        this.latestResponse = payload;
        this.render(payload);
        this.track("widget_impression", {
          subtotal: payload.subtotal,
          currentTier: payload.currentTier && payload.currentTier.code,
          nextTier: payload.nextTier && payload.nextTier.code,
        });
      } catch (error) {
        this.track("widget_error", { message: String(error) });
        this.renderError("Discount widget is unavailable right now.");
      }
    }

    render(data) {
      const recommendations = Array.isArray(data.recommendations) ? data.recommendations : [];
      const defaultVisibleCount = Math.max(3, Number(this.settings.maxRecommendations || 2));
      const recommendationTypeCounts = Object.create(null);
      recommendations.forEach((item) => {
        const type = normalizeRecommendationType(item && item.recommendationType);
        recommendationTypeCounts[type] = Number(recommendationTypeCounts[type] || 0) + 1;
      });
      const recommendationTypes = Array.from(
        new Set(
          recommendations
            .map((item) => normalizeRecommendationType(item && item.recommendationType))
            .filter(Boolean),
        ),
      );
      if (!this.typeFilterPinned || !recommendationTypes.includes(this.selectedRecommendationType)) {
        this.selectedRecommendationType = recommendationTypes[0] || "";
        this.typeFilterPinned = false;
      }
      const filteredRecommendations =
        this.selectedRecommendationType && recommendationTypes.includes(this.selectedRecommendationType)
          ? recommendations.filter(
              (item) =>
                normalizeRecommendationType(item && item.recommendationType) ===
                this.selectedRecommendationType,
            )
          : recommendations;
      if (!this.expandedRecommendations && filteredRecommendations.length <= defaultVisibleCount) {
        this.expandedRecommendations = false;
      }
      const visibleCount = this.expandedRecommendations
        ? filteredRecommendations.length
        : Math.min(defaultVisibleCount, filteredRecommendations.length);
      const visibleRecommendations = filteredRecommendations.slice(0, visibleCount);
      const remainingRecommendationCount = Math.max(
        0,
        filteredRecommendations.length - visibleCount,
      );
      const currentTierText = data.currentTier
        ? `${data.currentTier.code} (${data.currentTier.percent}%)`
        : "None";
      const nextTierText = data.nextTier
        ? `${data.nextTier.code} (${data.nextTier.percent}%)`
        : "Highest reached";
      const currentDiscountPercent = Number(data.currentDiscountPercent || 0);
      const tiers = Array.isArray(data.tiers) ? data.tiers : [];
      const maxTierPercent = tiers.length > 0
        ? Math.max(...tiers.map((tier) => Number(tier && tier.percent) || 0), 1)
        : 15;
      const tierMarkers = tiers
        .map((tier) => {
          const tierPercent = Number(tier && tier.percent) || 0;
          const left = Math.max(0, Math.min(100, (tierPercent / maxTierPercent) * 100));
          const isReached = currentDiscountPercent + 0.001 >= tierPercent;
          return `
            <span class="cdp-tier-marker ${isReached ? "cdp-tier-marker--reached" : ""}" style="left:${left}%">
              <span class="cdp-tier-marker-dot"></span>
              <span class="cdp-tier-marker-label">${escapeHtml(String(tierPercent))}%</span>
            </span>
          `;
        })
        .join("");
      const recommendationHtml =
        this.settings.recommendationsEnabled && recommendations.length > 0
          ? `
            <div class="cdp-recommendations">
              <div class="cdp-recommendations-head">
                <p class="cdp-recommendations-title">${escapeHtml(data.labels.recommendationHeading || "Recommended products")}</p>
                <span class="cdp-count">${recommendations.length} pick${recommendations.length > 1 ? "s" : ""}</span>
              </div>
              ${
                recommendationTypes.length > 1
                  ? `
                    <div class="cdp-type-tabs">
                      ${recommendationTypes
                        .map(
                          (type) => `
                            <button
                              type="button"
                              class="cdp-type-tab ${this.selectedRecommendationType === type ? "cdp-type-tab--active" : ""}"
                              data-cdp-type="${escapeAttr(type)}"
                            >
                              ${escapeHtml(type)} (${Number(recommendationTypeCounts[type] || 0)})
                            </button>
                          `,
                        )
                        .join("")}
                    </div>
                  `
                  : ""
              }
              ${
                data.labels && data.labels.pricingDisclaimer
                  ? `<p class="cdp-reco-disclaimer">${escapeHtml(String(data.labels.pricingDisclaimer))}</p>`
                  : ""
              }
              ${visibleRecommendations
                .map((item) => {
                  const variants = getRecommendationVariants(item);
                  const selectedVariant =
                    variants.find((entry) => String(entry.variantId) === String(item.variantId)) ||
                    variants[0];
                  const isExact = String(selectedVariant.pricingSource || item.pricingSource || "estimated") === "exact";
                  const hasSavings = isExact && Number(selectedVariant.estimatedSavings || 0) > 0;
                  const displayPrice = isExact
                    ? Number(selectedVariant.estimatedNetPrice ?? selectedVariant.price)
                    : Number(selectedVariant.price || 0);
                  const recommendedForText = getRecommendedForText(item.recommendedFor);
                  const recommendedBtuText = getRecommendedBtuText(item.recommendedForBtu);

                  return `
                  <div class="cdp-reco-item">
                    ${
                      item.imageUrl
                        ? `<img src="${item.imageUrl}" alt="${escapeHtml(item.title)}" loading="lazy">`
                        : `<div class="cdp-reco-fallback">+</div>`
                    }
                    <div class="cdp-reco-content">
                      <div class="cdp-reco-title-row">
                        <span class="cdp-reco-type">${escapeHtml(item.recommendationType || "Accessory")}</span>
                      </div>
                      ${
                        item.productUrl
                          ? `<a class="cdp-reco-title" href="${item.productUrl}">${escapeHtml(item.title)}</a>`
                          : `<span class="cdp-reco-title">${escapeHtml(item.title)}</span>`
                      }
                      <p class="cdp-reco-meta" data-cdp-benefit>${escapeHtml(selectedVariant.benefitLabel || item.benefitLabel || "")}</p>
                      ${
                        isExact
                          ? `<p class="cdp-reco-accuracy cdp-reco-accuracy--exact">Exact preview</p>`
                          : `<p class="cdp-reco-accuracy">Final discount shown after add to cart</p>`
                      }
                      ${
                        recommendedForText
                          ? `<p class="cdp-reco-for">Recommended for ${escapeHtml(recommendedForText)}</p>`
                          : ""
                      }
                      ${
                        recommendedBtuText
                          ? `<p class="cdp-reco-for cdp-reco-for-btu">For your ${escapeHtml(recommendedBtuText)} head</p>`
                          : ""
                      }
                      ${
                        variants.length > 1
                          ? `
                            <label class="cdp-variant-label">
                              Option
                              <select class="cdp-variant-select" data-cdp-variant-select>
                                ${variants
                                  .map(
                                    (variant) => `
                                      <option
                                        value="${escapeAttr(String(variant.variantId))}"
                                        ${String(variant.variantId) === String(selectedVariant.variantId) ? "selected" : ""}
                                        data-price="${Number(variant.price || 0)}"
                                        data-net="${Number(variant.estimatedNetPrice || 0)}"
                                        data-savings="${Number(variant.estimatedSavings || 0)}"
                                        data-benefit="${escapeAttr(String(variant.benefitLabel || ""))}"
                                        data-free="${variant.effectivelyFree ? "1" : "0"}"
                                        data-source="${escapeAttr(String(variant.pricingSource || "estimated"))}"
                                      >
                                        ${escapeHtml(getVariantOptionLabel(variant))}
                                      </option>
                                    `,
                                  )
                                  .join("")}
                              </select>
                            </label>
                          `
                          : ""
                      }
                    </div>
                    <div class="cdp-reco-actions">
                      <span class="cdp-price" data-cdp-net>
                        ${isExact ? "Exact" : "Price"} ${formatMoney(displayPrice)}
                      </span>
                      ${
                        hasSavings
                          ? `<span class="cdp-price-compare" data-cdp-compare>${formatMoney(selectedVariant.price)}</span>`
                          : `<span class="cdp-price-compare" data-cdp-compare hidden></span>`
                      }
                      ${
                        hasSavings
                          ? `<span class="cdp-save" data-cdp-save>Save ~${formatMoney(selectedVariant.estimatedSavings)}</span>`
                          : `<span class="cdp-save" data-cdp-save hidden></span>`
                      }
                      <button type="button" class="cdp-btn" data-cdp-add data-variant-id="${selectedVariant.variantId}" data-product-id="${item.productId}">Add</button>
                    </div>
                  </div>
                `;
                })
                .join("")}
              ${
                remainingRecommendationCount > 0
                  ? `<button type="button" class="cdp-more-btn" data-cdp-more-picks>Show ${Math.min(defaultVisibleCount, remainingRecommendationCount)} more picks</button>`
                  : this.expandedRecommendations &&
                    filteredRecommendations.length > defaultVisibleCount
                    ? `<button type="button" class="cdp-more-btn cdp-more-btn-less" data-cdp-less-picks>Show fewer picks</button>`
                    : ""
              }
            </div>
          `
          : "";

      this.root.innerHTML = `
        <div class="cdp-card">
          <div class="cdp-head">
            <p class="cdp-primary">${escapeHtml(data.labels.primaryMessage || "")}</p>
            <span class="cdp-status">${data.amountRemaining > 0 ? "In progress" : "Unlocked"}</span>
          </div>
          ${
            data.labels.secondaryMessage
              ? `<p class="cdp-secondary">${escapeHtml(data.labels.secondaryMessage)}</p>`
              : ""
          }
          <div class="cdp-progress">
            <div class="cdp-progress-bar" style="width:${Math.max(0, Math.min(100, data.journeyProgressPercent ?? data.progressPercent ?? 0))}%"></div>
            <div class="cdp-tier-markers">${tierMarkers}</div>
          </div>
          <div class="cdp-stats">
            <div class="cdp-stat">
              <span class="cdp-stat-label">Current discount</span>
              <span class="cdp-stat-value">${escapeHtml(formatPercent(currentDiscountPercent))}</span>
            </div>
            <div class="cdp-stat">
              <span class="cdp-stat-label">Next tier</span>
              <span class="cdp-stat-value">${escapeHtml(nextTierText)}</span>
            </div>
            <div class="cdp-stat">
              <span class="cdp-stat-label">Spend to unlock</span>
              <span class="cdp-stat-value">${Number(data.amountRemaining || 0) > 0 ? escapeHtml(formatMoney(data.amountRemaining || 0)) : "Unlocked"}</span>
            </div>
          </div>
          <div class="cdp-tier-row">
            <span class="cdp-tier-pill">Current: ${escapeHtml(currentTierText)}</span>
            <span class="cdp-tier-pill cdp-tier-pill-next">Next: ${escapeHtml(nextTierText)}</span>
          </div>
          ${recommendationHtml}
        </div>
      `;

      this.bindActions();
    }

    bindActions() {
      this.root.querySelectorAll("[data-cdp-type]").forEach((button) => {
        button.addEventListener("click", () => {
          const nextType = String(button.getAttribute("data-cdp-type") || "").trim();
          if (!nextType || nextType === this.selectedRecommendationType) return;
          this.selectedRecommendationType = nextType;
          this.typeFilterPinned = true;
          this.expandedRecommendations = false;
          if (this.latestResponse) this.render(this.latestResponse);
        });
      });

      const moreButton = this.root.querySelector("[data-cdp-more-picks]");
      if (moreButton) {
        moreButton.addEventListener("click", () => {
          this.expandedRecommendations = true;
          if (this.latestResponse) this.render(this.latestResponse);
        });
      }

      const lessButton = this.root.querySelector("[data-cdp-less-picks]");
      if (lessButton) {
        lessButton.addEventListener("click", () => {
          this.expandedRecommendations = false;
          if (this.latestResponse) this.render(this.latestResponse);
        });
      }

      this.root.querySelectorAll("[data-cdp-variant-select]").forEach((select) => {
        select.addEventListener("change", (event) => {
          syncRecommendationVariantState(event.currentTarget);
        });
      });

      this.root.querySelectorAll("[data-cdp-add]").forEach((button) => {
        button.addEventListener("click", async (event) => {
          const variantId = event.currentTarget.getAttribute("data-variant-id");
          const productId = event.currentTarget.getAttribute("data-product-id");
          if (!variantId) return;

          this.track("recommendation_click", { variantId, productId });

          try {
            const response = await fetch("/cart/add.js", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: String(variantId), quantity: 1 }),
            });

            if (response.ok) {
              this.track("recommendation_add_to_cart", { variantId, productId });
              window.dispatchEvent(new CustomEvent("cart:updated"));
              document.dispatchEvent(new CustomEvent("cart:updated"));
              await refreshStorefrontCartUI();
              await this.refresh();
            } else {
              let message = "Could not add this item to cart.";
              try {
                const json = await response.json();
                if (json?.description) message = String(json.description);
              } catch {
                // Keep default message.
              }
              rememberFailedVariantId(variantId);
              this.track("recommendation_add_error", { variantId, productId, status: response.status });
              this.renderError(message);
              await this.refresh();
            }
          } catch (error) {
            rememberFailedVariantId(variantId);
            this.track("recommendation_add_error", { message: String(error) });
            this.renderError("Could not add this item to cart.");
            await this.refresh();
          }
        });
      });
    }

    track(eventName, payload) {
      if (!this.settings.trackingEnabled) return;
      console.log(`[cdp] ${eventName}`, payload || {});
    }

    renderLoading() {
      this.root.innerHTML = `
        <div class="cdp-card cdp-state">
          <p class="cdp-primary">Checking your discount progress...</p>
        </div>
      `;
    }

    renderError(message) {
      this.root.innerHTML = `
        <div class="cdp-card cdp-state cdp-state-error">
          <p class="cdp-primary">${escapeHtml(message)}</p>
        </div>
      `;
    }
  }

  function formatMoney(amount) {
    return MONEY_FORMATTER.format(Number(amount || 0));
  }

  function formatPercent(value) {
    const num = Number(value || 0);
    const rounded = Math.round(num * 100) / 100;
    return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(2)}%`;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replaceAll("`", "&#96;");
  }

  function getRecommendationVariants(item) {
    const variants = Array.isArray(item && item.variants) ? item.variants : [];
    if (variants.length > 0) return variants;

    return [
      {
        variantId: item.variantId,
        variantTitle: item.variantTitle,
        price: Number(item.price || 0),
        estimatedNetPrice: Number(item.estimatedNetPrice || item.price || 0),
        estimatedSavings: Number(item.estimatedSavings || 0),
        effectivelyFree: Boolean(item.effectivelyFree),
        benefitLabel: item.benefitLabel || "",
        pricingSource: item.pricingSource || "estimated",
      },
    ];
  }

  function getVariantOptionLabel(variant) {
    const title = String(variant && variant.variantTitle ? variant.variantTitle : "").trim();
    const normalized = title.toLowerCase();
    const base = !title || normalized === "default title" ? "Default option" : title;
    return `${base} - ${formatMoney(Number(variant.price || 0))}`;
  }

  function getRecommendedForText(items) {
    if (!Array.isArray(items) || items.length === 0) return "";
    const clean = items.map((item) => String(item || "").trim()).filter(Boolean);
    if (clean.length === 0) return "";
    if (clean.length <= 2) return clean.join(" + ");
    return `${clean.slice(0, 2).join(" + ")} +${clean.length - 2} more`;
  }

  function getRecommendedBtuText(items) {
    if (!Array.isArray(items) || items.length === 0) return "";
    const clean = items
      .map((item) => Number(item))
      .filter((value) => Number.isFinite(value) && value >= 6000 && value <= 60000);
    if (clean.length === 0) return "";
    const sorted = Array.from(new Set(clean)).sort((a, b) => a - b);
    if (sorted.length === 1) return `${sorted[0].toLocaleString()} BTU`;
    if (sorted.length === 2) {
      return `${sorted[0].toLocaleString()} BTU + ${sorted[1].toLocaleString()} BTU`;
    }
    return `${sorted[0].toLocaleString()} BTU +${sorted.length - 1} more`;
  }

  function normalizeRecommendationType(value) {
    const normalized = String(value || "").trim();
    return normalized || "Accessories";
  }

  function syncRecommendationVariantState(select) {
    const row = select && select.closest ? select.closest(".cdp-reco-item") : null;
    if (!row) return;

    const selectedOption = select.selectedOptions && select.selectedOptions[0];
    if (!selectedOption) return;

    const button = row.querySelector("[data-cdp-add]");
    const benefit = row.querySelector("[data-cdp-benefit]");
    const net = row.querySelector("[data-cdp-net]");
    const compare = row.querySelector("[data-cdp-compare]");
    const save = row.querySelector("[data-cdp-save]");

    const variantId = selectedOption.value;
    const price = Number(selectedOption.getAttribute("data-price") || 0);
    const estimatedNet = Number(selectedOption.getAttribute("data-net") || price);
    const estimatedSavings = Number(selectedOption.getAttribute("data-savings") || 0);
    const benefitLabel = String(selectedOption.getAttribute("data-benefit") || "");
    const effectivelyFree = selectedOption.getAttribute("data-free") === "1";
    const pricingSource = String(selectedOption.getAttribute("data-source") || "estimated");
    const hasExact = pricingSource === "exact";
    const hasSavings = hasExact && estimatedSavings > 0;

    if (button) button.setAttribute("data-variant-id", variantId);
    if (benefit) benefit.textContent = benefitLabel;
    const accuracy = row.querySelector(".cdp-reco-accuracy");
    if (accuracy) {
      accuracy.textContent = hasExact
        ? "Exact preview"
        : "Final discount shown after add to cart";
      accuracy.classList.toggle("cdp-reco-accuracy--exact", hasExact);
    }
    if (net) {
      const displayNet = hasExact ? estimatedNet : price;
      net.textContent = `${hasExact ? "Exact" : "Price"} ${formatMoney(displayNet)}`;
      net.classList.toggle("cdp-price-free", hasExact && effectivelyFree && estimatedNet <= 0.01);
    }
    if (compare) {
      if (hasSavings) {
        compare.hidden = false;
        compare.textContent = formatMoney(price);
      } else {
        compare.hidden = true;
        compare.textContent = "";
      }
    }
    if (save) {
      if (hasSavings) {
        save.hidden = false;
        save.textContent = `${hasExact ? "Save ~" : "Est. save ~"}${formatMoney(estimatedSavings)}`;
      } else {
        save.hidden = true;
        save.textContent = "";
      }
    }
  }

  function buildCartLines(cart) {
    return (cart.items || [])
      .map((item) => {
        const productId = String(item.product_id || "").trim();
        const variantId = String(item.variant_id || "").trim();
        if (!productId || !variantId) return null;

        return {
          productId,
          variantId,
          quantity: Math.max(1, Number(item.quantity || 1)),
          sku: String(item.sku || "").trim(),
          handle: normalizeHandle(item.handle || item.product_handle || ""),
          title: String(item.product_title || item.title || "").trim(),
          variantTitle: String(item.variant_title || "").trim(),
        };
      })
      .filter(Boolean);
  }

  function getCurrentDiscountPercent(cart) {
    const originalTotal = Number(cart && cart.original_total_price);
    const discountedTotal = Number(cart && cart.total_price);

    if (!Number.isFinite(originalTotal) || originalTotal <= 0 || !Number.isFinite(discountedTotal)) {
      return 0;
    }

    const percent = ((originalTotal - discountedTotal) / originalTotal) * 100;
    const rounded = Math.round(percent * 100) / 100;
    return Math.max(0, Math.min(100, rounded));
  }

  async function resolveCartAccessoryHints(cartLines) {
    if (!Array.isArray(cartLines) || cartLines.length === 0) {
      return { productIds: [], handles: [], links: [] };
    }

    const tecinfoMap = await loadTecinfoMap(cartLines);
    if (!tecinfoMap) {
      return { productIds: [], handles: [], links: [] };
    }

    const productIds = [];
    const handles = [];
    const links = [];
    const seenProducts = new Set();
    const seenHandles = new Set();
    const seenLinks = new Set();
    const seenSourceRecord = new Set();

    cartLines.forEach((line) => {
      const sourceHandle = normalizeHandle(line && line.handle);
      const sourceProductId = String((line && line.productId) || "").trim();
      if (!sourceHandle && !sourceProductId) return;

      const lineSkus = normalizeAndDedupeSkus("", [line.sku].filter(Boolean));
      if (lineSkus.length === 0) return;

      lineSkus.forEach((sku) => {
        const expanded = [sku, ...deriveMrCoolComponents(sku)];

        expanded.forEach((candidateSku) => {
          const key = String(candidateSku || "").toUpperCase();
          if (!key) return;

          let record = tecinfoMap[key] || null;
          if (!record) {
            record = fuzzyFindMrCoolRecord(key, tecinfoMap);
          }
          if (!record) return;

          const sourceRecordKey = `${sourceProductId || sourceHandle}::${String(record.sku || "").toUpperCase()}`;
          if (seenSourceRecord.has(sourceRecordKey)) return;
          seenSourceRecord.add(sourceRecordKey);

          const accessories = normalizeAccessoryList(record.accessories || []);
          accessories.forEach((item) => {
            const accessoryProductId = String(item.productId || "").trim();
            const accessoryHandle = normalizeHandle(item.handle);

            if (sourceProductId && accessoryProductId && sourceProductId === accessoryProductId) {
              return;
            }
            if (sourceHandle && accessoryHandle && sourceHandle === accessoryHandle) {
              return;
            }

            if (accessoryProductId && !seenProducts.has(accessoryProductId)) {
              seenProducts.add(accessoryProductId);
              productIds.push(accessoryProductId);
            }
            if (accessoryHandle && !seenHandles.has(accessoryHandle)) {
              seenHandles.add(accessoryHandle);
              handles.push(accessoryHandle);
            }

            const linkKey = `${accessoryProductId}|${accessoryHandle}|${sourceHandle}`;
            if (!accessoryProductId && !accessoryHandle) return;
            if (!sourceHandle) return;
            if (seenLinks.has(linkKey)) return;

            seenLinks.add(linkKey);
            links.push({
              productId: accessoryProductId,
              handle: accessoryHandle,
              sourceHandle,
            });
          });
        });
      });
    });

    return {
      productIds: productIds.slice(0, 80),
      handles: handles.slice(0, 80),
      links: links.slice(0, 80),
    };
  }

  async function loadTecinfoMap(cartLines) {
    if (ACCESSORY_HINT_CACHE.tecinfoMap) {
      return ACCESSORY_HINT_CACHE.tecinfoMap;
    }

    if (!ACCESSORY_HINT_CACHE.tecinfoLoading) {
      ACCESSORY_HINT_CACHE.tecinfoLoading = (async () => {
        const tecinfoUrl = await discoverTecinfoUrl(cartLines);
        if (!tecinfoUrl) return null;
        ACCESSORY_HINT_CACHE.tecinfoUrl = tecinfoUrl;

        try {
          const response = await fetch(tecinfoUrl, { cache: "force-cache" });
          if (!response.ok) return null;
          const raw = await response.json();
          const db = normalizeTecinfoDb(raw);
          const map = Object.create(null);

          db.forEach((entry) => {
            if (!entry || !entry.sku) return;
            map[String(entry.sku).toUpperCase()] = entry;
          });

          ACCESSORY_HINT_CACHE.tecinfoMap = map;
          return map;
        } catch {
          return null;
        }
      })();
    }

    return ACCESSORY_HINT_CACHE.tecinfoLoading;
  }

  async function discoverTecinfoUrl(cartLines) {
    if (ACCESSORY_HINT_CACHE.tecinfoUrl) {
      return ACCESSORY_HINT_CACHE.tecinfoUrl;
    }

    const handles = Array.from(
      new Set(
        cartLines
          .map((line) => normalizeHandle(line.handle))
          .filter(Boolean),
      ),
    ).slice(0, 4);

    for (const handle of handles) {
      try {
        const response = await fetch(`/products/${encodeURIComponent(handle)}`, {
          method: "GET",
          credentials: "same-origin",
        });
        if (!response.ok) continue;

        const html = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        const source = doc.querySelector(
          "#sms-techdata-source.tech-data-root, #sms-techdata-source, .tech-data-root[data-techdata-json]",
        );
        const tecinfoUrl = source && source.getAttribute("data-techdata-json");
        if (tecinfoUrl) {
          ACCESSORY_HINT_CACHE.tecinfoUrl = tecinfoUrl;
          return tecinfoUrl;
        }
      } catch {
        // Ignore and continue with next product handle.
      }
    }

    return null;
  }

  function normalizeTecinfoDb(raw) {
    if (Array.isArray(raw)) return raw;
    if (raw && Array.isArray(raw.items)) return raw.items;
    if (raw && Array.isArray(raw.records)) return raw.records;
    if (raw && typeof raw === "object") return [raw];
    return [];
  }

  function normalizeAndDedupeSkus(prodSku, variantSkus) {
    const set = Object.create(null);
    const add = (value) => {
      if (!value) return;
      set[String(value)] = 1;
    };

    add(prodSku);
    (variantSkus || []).forEach(add);

    const cleaned = [];
    Object.keys(set).forEach((sku) => {
      String(sku)
        .split("+")
        .forEach((part) => {
          const normalized = normalizeSkuPart(part);
          if (normalized) cleaned.push(normalized);
        });
    });

    const deduped = [];
    const seen = Object.create(null);
    cleaned.forEach((sku) => {
      const key = String(sku).toUpperCase();
      if (seen[key]) return;
      seen[key] = 1;
      deduped.push(sku);
    });

    return deduped;
  }

  function normalizeSkuPart(skuPart) {
    if (!skuPart) return "";
    return String(skuPart)
      .trim()
      .replace(/^(\d+)\s*[xX]\s*[-_]?/, "")
      .replace(/^[xX]\s*(\d+)\s*[-_]?/, "")
      .replace(/[-_]?[xX]\s*\d+$/, "")
      .replace(/\d+\s*[xX]$/, "")
      .trim();
  }

  function deriveMrCoolComponents(baseSku) {
    const up = String(baseSku || "").toUpperCase();
    const parts = up.split("-");
    const hpIndex = parts.indexOf("HP");
    if (hpIndex === -1) return [];
    const head = parts.slice(0, hpIndex + 1);
    const tail = parts.slice(hpIndex + 1);
    const build = (insert) => [...head, insert, ...tail].join("-");
    return [build("C"), build("WMAH"), build("MUAH")];
  }

  function fuzzyFindMrCoolRecord(sku, map) {
    const parts = String(sku || "").toUpperCase().split("-");
    const hpIndex = parts.indexOf("HP");
    if (hpIndex < 0 || hpIndex >= parts.length - 1) return null;

    const headInsert = parts.slice(0, hpIndex + 2).join("-");
    const tailWanted = parts.slice(hpIndex + 2).join("-").replace(/[0-9]/g, "");
    const prefix = `${headInsert}-`;

    for (const upSku in map) {
      if (!upSku.startsWith(prefix)) continue;
      const candidateTail = upSku.slice(prefix.length).replace(/[0-9]/g, "");
      if (candidateTail === tailWanted) return map[upSku];
    }

    return null;
  }

  function normalizeAccessoryList(accessories) {
    if (!Array.isArray(accessories)) return [];

    const out = [];
    const seen = Object.create(null);
    const pushItem = (raw) => {
      if (!raw) return;
      const productId = String(raw.product_id || raw.id || "").trim();
      const url =
        String(raw.url || raw.link || raw.href || raw.product_url || "").trim();
      const handle = normalizeHandle(raw.handle || getHandleFromUrl(url));
      const key = productId || handle || url;
      if (!key || seen[key]) return;
      seen[key] = 1;
      out.push({ productId, handle, url });
    };

    accessories.forEach((item) => {
      if (!item) return;
      if (typeof item === "string") {
        pushItem({ url: item });
        return;
      }
      if (typeof item === "object") {
        pushItem(item);
        (item.alt_products || []).forEach((alt) => {
          if (!alt) return;
          pushItem(alt);
        });
      }
    });

    return out;
  }

  function getHandleFromUrl(url) {
    if (!url) return "";
    try {
      const parsed = new URL(url, window.location.origin);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const productIndex = segments.indexOf("products");
      if (productIndex > -1 && segments[productIndex + 1]) {
        return segments[productIndex + 1];
      }
      return segments.pop() || "";
    } catch {
      return "";
    }
  }

  function normalizeHandle(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "");
  }

  function getFailedVariantIds() {
    try {
      const raw = window.localStorage.getItem("cdp_failed_variant_ids") || "[]";
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((v) => String(v)).filter(Boolean);
    } catch {
      return [];
    }
  }

  function rememberFailedVariantId(variantId) {
    try {
      const current = new Set(getFailedVariantIds());
      current.add(String(variantId));
      const trimmed = Array.from(current).slice(-200);
      window.localStorage.setItem("cdp_failed_variant_ids", JSON.stringify(trimmed));
    } catch {
      // Ignore localStorage failures.
    }
  }

  async function refreshStorefrontCartUI() {
    // Emit common cart refresh events used by many themes.
    ["cart:updated", "cart:refresh", "ajaxProduct:added", "cart:change"].forEach((eventName) => {
      window.dispatchEvent(new CustomEvent(eventName));
      document.dispatchEvent(new CustomEvent(eventName));
    });

    const isCartPage =
      window.location.pathname === "/cart" || window.location.pathname.startsWith("/cart/");
    const sectionIds = ["main-cart-items", "main-cart-footer", "cart-icon-bubble", "cart-drawer"];
    const url = `/cart?sections=${encodeURIComponent(sectionIds.join(","))}`;

    try {
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) {
        if (isCartPage) window.location.reload();
        return;
      }

      const sections = await response.json();
      let replacedAny = false;

      sectionIds.forEach((sectionId) => {
        const html = sections && sections[sectionId];
        if (!html) return;

        const sectionElement = document.getElementById(`shopify-section-${sectionId}`);
        if (sectionElement) {
          sectionElement.innerHTML = html;
          replacedAny = true;
        }
      });

      if (isCartPage && !replacedAny) {
        window.location.reload();
      }
    } catch {
      if (isCartPage) {
        window.location.reload();
      }
    }
  }

  function initializeWidgets() {
    document.querySelectorAll("[data-cdp-widget]").forEach((root) => {
      if (root.__cdpInitialized) return;
      root.__cdpInitialized = true;
      const widget = new CartDiscountWidget(root);
      root.__cdpInstance = widget;
      widget.refresh();
    });
  }

  function refreshAllWidgets() {
    document.querySelectorAll("[data-cdp-widget]").forEach((root) => {
      if (root.__cdpInstance) {
        root.__cdpInstance.refresh();
      }
    });
  }

  function mountDrawerWidgets() {
    document.querySelectorAll("[data-cdp-host]").forEach((host) => {
      const selectors = (host.dataset.drawerSelectors || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (selectors.length === 0) return;

      selectors.forEach((selector) => {
        const drawer = document.querySelector(selector);
        if (!drawer) return;
        if (drawer.querySelector("[data-cdp-widget]")) return;

        const mount = document.createElement("div");
        mount.className = "cdp-widget cdp-widget--drawer";
        mount.setAttribute("data-cdp-widget", "true");
        mount.dataset.endpoint = host.dataset.endpoint || "";
        mount.dataset.tiers = host.dataset.tiers || "";
        mount.dataset.maxRecommendations = host.dataset.maxRecommendations || "2";
        mount.dataset.nearThresholdPercent = host.dataset.nearThresholdPercent || "20";
        mount.dataset.recommendationsEnabled = host.dataset.recommendationsEnabled || "true";
        mount.dataset.trackingEnabled = host.dataset.trackingEnabled || "true";
        mount.dataset.xyzHintEnabled = host.dataset.xyzHintEnabled || "false";
        mount.dataset.xyzHintMessage = host.dataset.xyzHintMessage || "";
        drawer.prepend(mount);
      });
    });
  }

  function init() {
    mountDrawerWidgets();
    initializeWidgets();

    let refreshTimer = null;
    const refreshAll = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        mountDrawerWidgets();
        initializeWidgets();
        refreshAllWidgets();
      }, 300);
    };

    ["cart:updated", "cart:refresh", "ajaxProduct:added"].forEach((eventName) => {
      document.addEventListener(eventName, refreshAll);
      window.addEventListener(eventName, refreshAll);
    });

    const nativeFetch = window.fetch;
    window.fetch = async function (...args) {
      const result = await nativeFetch.apply(this, args);
      const requestUrl = String((args[0] && args[0].url) || args[0] || "");
      if (requestUrl.includes("/cart/")) {
        refreshAll();
      }
      return result;
    };

    const observer = new MutationObserver(() => {
      mountDrawerWidgets();
      initializeWidgets();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
