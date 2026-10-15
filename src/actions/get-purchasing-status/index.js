import { Core } from '@adobe/aio-sdk';

const BACKORDER_MODES = Object.freeze({
  0: 'NO_BACKORDERS',
  1: 'ALLOW',
  2: 'ALLOW_AND_NOTIFY',
});

function response(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
    body,
  };
}

function parseBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return Boolean(value);
}

/**
 * Resolve the effective backorders mode for a stock item.
 *
 * Magento 2 stores backorders as:
 *   0 = No backorders
 *   1 = Allow qty below 0
 *   2 = Allow qty below 0 and notify customer
 *
 * When use_config_backorders = true the product inherits the store-level
 * global setting. Commerce REST does not return the resolved global value on
 * the product payload, so we fall back to 0 (safe default) and surface a
 */
function deriveBackorders(stockItem) {
  if (!stockItem) return 0;
  const directValue = Number(stockItem.backorders);
  if (Number.isFinite(directValue)) return directValue;
  return 0;
}

/**
 * Replicate Magento 2 product availability logic for the storefront.
 *
 * Magento 2 stock status rules (Magento\CatalogInventory\Model\Stock\Item):
 *
 *  1. manage_stock = false → always saleable regardless of qty
 *  2. qty > min_qty        → IN_STOCK
 *  3. qty <= min_qty AND backorders ≠ 0 → BACKORDER (still orderable)
 *  4. qty <= min_qty AND backorders = 0  → OUT_OF_STOCK
 *
 * min_qty defaults to 0 in Magento. A negative min_qty (e.g. -10) extends
 * the backorder window: customers may order until qty reaches that floor.
 *
 * notify_stock_qty is the "Only X left" low-stock threshold shown on PDP.
 */
function resolvePurchasingStatus(stockItem) {
  if (!stockItem) {
    return {
      quantity: 0,
      minQty: 0,
      isInStock: false,
      manageStock: true,
      backorderAllowed: false,
      backorderMode: 'NO_BACKORDERS',
      purchasingStatus: 'OUT_OF_STOCK',
      purchasingMessage: 'Out of Stock',
      lowStockMessage: null,
    };
  }

  const quantity     = Number(stockItem.qty ?? 0);
  const minQty       = Number(stockItem.min_qty ?? 0);
  const notifyQty    = stockItem.notify_stock_qty != null ? Number(stockItem.notify_stock_qty) : null;
  const manageStock  = parseBoolean(stockItem.manage_stock ?? true);
  const backorders   = deriveBackorders(stockItem);
  const backorderAllowed = backorders === 1 || backorders === 2;
  const backorderMode    = BACKORDER_MODES[backorders] ?? 'UNKNOWN';

  // ── Rule 1: Stock management disabled → always available ──────────────────
  if (!manageStock) {
    return {
      quantity,
      minQty,
      isInStock: true,
      manageStock: false,
      backorderAllowed,
      backorderMode,
      purchasingStatus: 'IN_STOCK',
      purchasingMessage: 'In Stock',
      lowStockMessage: null,
    };
  }

  // ── Rule 2: Physical stock exists AND above threshold → In Stock ───────────
  // qty > 0 : có hàng thực tế
  // qty > minQty : chưa chạm ngưỡng cấu hình (min_qty)
  // Cả hai điều kiện đều cần thiết. Ví dụ: qty=3, min_qty=5 → hàng còn nhưng
  // đã dưới ngưỡng cấu hình → không phải IN_STOCK.
  if (quantity > 0 && quantity > minQty) {
    // Low-stock warning: show "Only N left" when qty ≤ notify_stock_qty
    const lowStockMessage =
      notifyQty !== null && quantity <= notifyQty
        ? `Only ${quantity} left in stock`
        : null;

    return {
      quantity,
      minQty,
      isInStock: true,
      manageStock: true,
      backorderAllowed,
      backorderMode,
      purchasingStatus: 'IN_STOCK',
      purchasingMessage: 'In Stock',
      lowStockMessage,
    };
  }

  // ── Rule 3: Backorder allowed → Backorder ─────────────────────────────────
  // Các trường hợp còn lại khi backorder được bật:
  //   qty ≤ 0 AND qty > min_qty : stock âm, đang nhận đơn backorder, trên sàn
  //   qty > 0 AND qty ≤ min_qty : còn hàng nhưng dưới ngưỡng cấu hình
  //   qty ≤ min_qty             : chạm/dưới sàn, Magento vẫn cho đặt khi backorder bật
  if (backorderAllowed) {
    const purchasingMessage =
      backorders === 2
        ? 'This product is on backorder'   // ALLOW_AND_NOTIFY → hiển thị thông báo
        : 'Backorder Available';            // ALLOW → không thông báo

    return {
      quantity,
      minQty,
      isInStock: false,
      manageStock: true,
      backorderAllowed: true,
      backorderMode,
      purchasingStatus: 'BACKORDER',
      purchasingMessage,
      lowStockMessage: null,
    };
  }

  // ── Rule 4: No backorders, threshold hit → Out of Stock ───────────────────
  return {
    quantity,
    minQty,
    isInStock: false,
    manageStock: true,
    backorderAllowed: false,
    backorderMode,
    purchasingStatus: 'OUT_OF_STOCK',
    purchasingMessage: 'Out of Stock',
    lowStockMessage: null,
  };
}

function extractStockItem(product) {
  return product?.extension_attributes?.stock_item ?? null;
}

async function getCommerceProduct({ baseUrl, sku, token, storeCode, logger }) {
  const encodedSku = encodeURIComponent(sku);
  // Request all fields needed to replicate Magento 2 storefront logic
  const fields = encodeURIComponent(
    'sku,name,extension_attributes[stock_item[qty,is_in_stock,manage_stock,use_config_manage_stock,backorders,use_config_backorders,min_qty,use_config_min_qty,notify_stock_qty,use_config_notify_stock_qty]]',
  );
  const url = `${baseUrl.replace(/\/$/, '')}/V1/products/${encodedSku}?fields=${fields}`;

  logger.info(`Calling Commerce REST for SKU ${sku}`);

  const commerceResponse = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      store: storeCode || 'default',
    },
  });

  const text = await commerceResponse.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!commerceResponse.ok) {
    const error = new Error(`Commerce REST returned HTTP ${commerceResponse.status}`);
    error.statusCode = commerceResponse.status;
    error.details = data;
    throw error;
  }

  return data;
}

export async function main(params) {
  const logger = Core.Logger('get-purchasing-status', { level: params.LOG_LEVEL || 'info' });

  const sku = String(params.sku || '').trim();
  if (!sku) {
    return response(400, {
      error: 'INVALID_REQUEST',
      message: 'Query parameter "sku" is required.',
    });
  }

  if (!params.COMMERCE_BASE_URL) {
    return response(500, {
      error: 'CONFIGURATION_ERROR',
      message: 'COMMERCE_BASE_URL is not configured.',
    });
  }

  if (!params.COMMERCE_AUTH_TOKEN) {
    return response(500, {
      error: 'CONFIGURATION_ERROR',
      message: 'COMMERCE_AUTH_TOKEN is not configured.',
    });
  }

  try {
    const product = await getCommerceProduct({
      baseUrl: params.COMMERCE_BASE_URL,
      sku,
      token: params.COMMERCE_AUTH_TOKEN,
      storeCode: params.COMMERCE_STORE_CODE,
      logger,
    });

    const stockItem = extractStockItem(product);
    const status = resolvePurchasingStatus(stockItem);

    const warnings = [];

    if (!stockItem) {
      warnings.push(
        'Commerce product response did not include extension_attributes.stock_item. Verify the REST response and permissions.',
      );
    }

    // Warn when product inherits global backorder/manage_stock/min_qty config.
    // Commerce REST does not resolve the effective global value on the product
    // payload, so the displayed status may differ from the Magento storefront.
    if (parseBoolean(stockItem?.use_config_backorders)) {
      warnings.push(
        'use_config_backorders is enabled. Backorder mode is inherited from global store config and may not be reflected accurately here.',
      );
    }
    if (parseBoolean(stockItem?.use_config_manage_stock)) {
      warnings.push(
        'use_config_manage_stock is enabled. manage_stock is inherited from global store config.',
      );
    }
    if (parseBoolean(stockItem?.use_config_min_qty)) {
      warnings.push(
        'use_config_min_qty is enabled. min_qty is inherited from global store config.',
      );
    }

    return response(200, {
      sku: product?.sku || sku,
      name: product?.name || null,
      quantity: status.quantity,
      minQty: status.minQty,
      isInStock: status.isInStock,
      manageStock: status.manageStock,
      backorderAllowed: status.backorderAllowed,
      backorderMode: status.backorderMode,
      purchasingStatus: status.purchasingStatus,
      purchasingMessage: status.purchasingMessage,
      lowStockMessage: status.lowStockMessage,
      source: { stockItem },
      warnings,
    });
  } catch (error) {
    logger.error(error);
    const upstreamStatus = error.statusCode || 500;
    return response(upstreamStatus >= 400 && upstreamStatus < 600 ? upstreamStatus : 500, {
      error: 'COMMERCE_REQUEST_FAILED',
      message: error.message || 'Unable to load product inventory data.',
      details: error.details || null,
    });
  }
}
