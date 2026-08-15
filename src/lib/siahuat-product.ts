import * as cheerio from "cheerio";

export type ScrapedSiaHuatProduct = {
  stock_id: string;
  source_stock_id: string | null;
  source_product_id: string;
  name: string;
  source_url: string;
  image_url: string | null;
  description: string | null;
  size: string | null;
  dimensions: string | null;
  brand: string | null;
  model: string | null;
  price_ex_gst: number;
  in_stock: boolean;
  available_quantity: number | null;
  stock_status: "in_stock" | "out_of_stock" | "unknown";
  category: string | null;
  subcategory: string | null;
  third_category: string | null;
  uom_id: string;
  attributes: Record<string, string>;
  last_scraped_at: string;
};

function clean(value: string | null | undefined) {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized && normalized !== "-" ? normalized : null;
}

function decodeFlightData(html: string) {
  const $ = cheerio.load(html);
  return $("script")
    .map((_index, element) => {
      const script = $(element).html() ?? "";
      const marker = "self.__next_f.push(";
      const start = script.indexOf(marker);
      if (start < 0 || !script.endsWith(")")) return "";
      try {
        const payload = JSON.parse(script.slice(start + marker.length, -1)) as unknown[];
        return typeof payload[1] === "string" ? payload[1] : "";
      } catch {
        return "";
      }
    })
    .get()
    .join("");
}

function flightString(flightData: string, key: string) {
  const match = flightData.match(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`));
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1].replace(/\\u0026/g, "&").replace(/\\"/g, '"');
  }
}

function flightNumber(flightData: string, key: string) {
  const match = flightData.match(new RegExp(`"${key}":(-?\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : null;
}

function originalImageUrl(src: string | undefined, productUrl: string) {
  if (!src) return null;
  try {
    const parsed = new URL(src, productUrl);
    if (parsed.pathname === "/_next/image") {
      const original = parsed.searchParams.get("url");
      return original ? new URL(original, productUrl).toString() : parsed.toString();
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function parseSiaHuatProductPage(html: string, productUrl: string): ScrapedSiaHuatProduct {
  const $ = cheerio.load(html);
  const flightData = decodeFlightData(html);
  const sourceProductId = new URL(productUrl).pathname.split("/").filter(Boolean).at(-1) ?? "";
  const title = $("h5").filter((_index, element) => $(element).closest("div").text().includes("code:")).first();
  const name = clean(title.text()) ?? clean($("title").text().replace(/\s*\|\s*Sia Huat E-store\s*$/i, ""));
  if (!name) throw new Error(`PRODUCT_NAME_NOT_FOUND: ${productUrl}`);

  const itemCode = clean(
    $("span")
      .filter((_index, element) => /^code\s*:/i.test($(element).text().trim()))
      .first()
      .text()
      .replace(/^code\s*:\s*/i, ""),
  );
  if (!itemCode) throw new Error(`ITEM_CODE_NOT_FOUND: ${productUrl}`);

  const attributes: Record<string, string> = {};
  title.closest(".MuiGrid-container").find("h6").each((_index, heading) => {
    const label = clean($(heading).text());
    const value = clean($(heading).parent().find("p").first().text());
    if (label && value) attributes[label] = value;
  });

  // This is the live value the Sia Huat product page renders as
  // `Available: n` inside its Add to cart dialog.
  const availableQuantity = flightNumber(flightData, "availableQty");
  const embeddedPrice = flightNumber(flightData, "b2bPrice");
  const displayedPrice = (() => {
    const text = title.closest(".MuiGrid-container").text();
    const match = text.match(/\$\s*([\d,]+)\s*\.\s*(\d{2})\s*ex GST/i);
    return match ? Number(`${match[1].replace(/,/g, "")}.${match[2]}`) : null;
  })();
  const price = embeddedPrice ?? displayedPrice;
  if (price === null || !Number.isFinite(price)) throw new Error(`PRICE_NOT_FOUND: ${productUrl}`);

  const productImage = $("img").filter((_index, element) => clean($(element).attr("alt")) === name).first();
  const inStock = availableQuantity !== null ? availableQuantity > 0 : false;

  return {
    stock_id: itemCode,
    source_stock_id: flightString(flightData, "stkId"),
    source_product_id: sourceProductId,
    name,
    source_url: productUrl.split("#")[0],
    image_url: originalImageUrl(productImage.attr("src"), productUrl),
    description: attributes.Description ?? flightString(flightData, "ref1"),
    size: attributes.Size ?? flightString(flightData, "ref6"),
    dimensions: attributes.Dimensions ?? null,
    brand: attributes.Brand ?? flightString(flightData, "brandName"),
    model: attributes.Model ?? flightString(flightData, "model"),
    price_ex_gst: price,
    in_stock: inStock,
    available_quantity: availableQuantity,
    stock_status: availableQuantity === null ? "unknown" : inStock ? "in_stock" : "out_of_stock",
    category: flightString(flightData, "eccatName"),
    subcategory: flightString(flightData, "ecsubcatName"),
    third_category: flightString(flightData, "ec3rdcatName"),
    uom_id: flightString(flightData, "uomId") ?? "EA",
    attributes,
    last_scraped_at: new Date().toISOString(),
  };
}

export async function fetchSiaHuatProduct(productUrl: string) {
  const url = new URL(productUrl);
  if (url.protocol !== "https:" || url.hostname !== "store.siahuat.com" || !/^\/product\/\d+$/.test(url.pathname)) {
    throw new Error("INVALID_SIA_HUAT_PRODUCT_URL");
  }

  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Hi-Lite-SiaHuat-B2B-Catalogue/1.0",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`SIA_HUAT_HTTP_${response.status}`);
  return parseSiaHuatProductPage(await response.text(), url.toString());
}
