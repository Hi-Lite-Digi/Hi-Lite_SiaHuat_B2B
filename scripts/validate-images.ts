import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { postChat, qaBaseUrl, writeQaReport } from "./qa-utils";

function expectedStockId(filePath: string) {
  return path.basename(filePath, path.extname(filePath)).replace(/-portrait$/i, "").toUpperCase();
}

type ProductImageFixture = {
  filePath: string;
  expected: string;
  message?: string;
  maximumDurationMs?: number;
};

const imageFixtureDir = path.resolve("test-fixtures", "images");
const defaultFixtures: ProductImageFixture[] = [
  { filePath: path.join(imageFixtureDir, "101CA-1000LCD.jpg"), expected: "101CA-1000LCD" },
  { filePath: path.join(imageFixtureDir, "101CA-1520CBP-110.jpg"), expected: "101CA-1520CBP-110" },
  // The same product on a phone-portrait canvas ensures a tall product photo
  // is not rejected merely because it has screenshot-like dimensions.
  {
    filePath: path.join(imageFixtureDir, "101CA-1000LCD-portrait.jpg"),
    expected: "101CA-1000LCD",
    message: "Do you sell this beverage dispenser? Need 1.",
    // A curated fingerprint should use the deterministic catalogue path. If it
    // falls through to the vision workflow, it typically reaches the 26-second
    // customer deadline instead of returning promptly.
    maximumDurationMs: 18_000,
  },
];
const comparisonScreenshot = path.join(imageFixtureDir, "rice-dispenser-comparison.png");
const randomNonProductImage = path.join(imageFixtureDir, "random-non-product.png");
const cliFixtures = process.argv.slice(2);
const fixtures: ProductImageFixture[] = cliFixtures.length > 0
  ? cliFixtures.map((filePath) => {
      const resolvedPath = path.resolve(filePath);
      return defaultFixtures.find((fixture) => path.resolve(fixture.filePath) === resolvedPath)
        ?? { filePath, expected: expectedStockId(filePath) };
    })
  : defaultFixtures;

function oracleStockIds(expected: string) {
  const withoutSupplierPrefix = expected.replace(/^\d{3}[A-Z]{2}-/, "");
  return [...new Set([expected, withoutSupplierPrefix])];
}

function words(value: string) {
  const ignored = new Set(["with", "and", "for", "the", "new", "version"]);
  return new Set(
    value.toLowerCase().match(/[a-z]{3,}/g)?.filter((word) => !ignored.has(word)) ?? [],
  );
}

function isSameProductFamily(expectedName: string, candidateName: string) {
  const expected = expectedName.toLowerCase();
  const candidate = candidateName.toLowerCase();

  if (/camtainer|beverage dispenser|drink dispenser/.test(expected)) {
    return /camtainer|beverage dispenser|drink dispenser|tea dispenser|beverage server|drink server/.test(candidate);
  }
  if (/utility box|cambox|storage box/.test(expected)) {
    return /utility box|cambox|storage box|container|storage bin/.test(candidate);
  }

  const expectedWords = words(expectedName);
  return [...words(candidateName)].filter((word) => expectedWords.has(word)).length >= 2;
}

function fallbackFamilyForFixture(expected: string) {
  if (/1000LCD$/i.test(expected)) {
    return /camtainer|beverage dispenser|drink dispenser|tea dispenser|beverage server|drink server/i;
  }
  return null;
}

async function getOracleProduct(expected: string) {
  for (const stockId of oracleStockIds(expected)) {
    const { body } = await postChat({
      message: stockId,
      sessionId: `image-oracle-${crypto.randomUUID()}`,
    });
    const products = [
      ...(body.selectedProduct ? [body.selectedProduct] : []),
      ...(body.products ?? []),
    ];
    const exact = products.find((product) => product.stock_id.toUpperCase() === stockId)
      ?? products.find((product) => product.stock_id.toUpperCase().startsWith(stockId));
    if (exact) return exact;
  }
  return null;
}

function mimeTypeFor(filePath: string) {
  return path.extname(filePath).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
}

async function validateImage(fixture: ProductImageFixture, index: number) {
  const { filePath, expected } = fixture;
  const sentMessage = fixture.message ?? "Do you sell this? Please identify it and show the SKU and catalogue price.";
  const bytes = await fs.readFile(filePath);
  const oracle = await getOracleProduct(expected);
  const fallbackFamily = fallbackFamilyForFixture(expected);
  const { status, body, durationMs } = await postChat({
    message: sentMessage,
    image: {
      dataUrl: `data:${mimeTypeFor(filePath)};base64,${bytes.toString("base64")}`,
      mimeType: mimeTypeFor(filePath),
      // Deliberately hide the source filename from the bot. The filename is
      // only the test oracle used after the response has been received.
      name: `qa-pixel-only-upload-${index + 1}.jpg`,
    },
  });

  const returned = [
    ...(body.selectedProduct ? [body.selectedProduct] : []),
    ...(body.products ?? []),
  ];
  const relevant = oracle
    ? returned.filter((product) =>
        product.stock_id.toUpperCase() === oracle.stock_id.toUpperCase()
        || isSameProductFamily(oracle.name, product.name))
    : fallbackFamily
      ? returned.filter((product) => fallbackFamily.test(product.name))
      : [];
  const responseMessage = typeof body.message === "string" ? body.message : "";
  const positiveExactClaim = /\b(this is|identified as|exactly matches|confirmed as|definitely)\b/i.test(responseMessage);
  const qualifiedAsSuggestion = /\b(suggest|possible|likely|looks like|could be|appears to be)\b/i.test(responseMessage);
  const claimsExactWithoutEvidence = positiveExactClaim && !qualifiedAsSuggestion;
  const failures = [
    durationMs < (fixture.maximumDurationMs ?? 30_000)
      ? null
      : `Reply took ${durationMs}ms; expected under ${fixture.maximumDurationMs ?? 30_000}ms`,
    status === 200 ? null : `HTTP ${status}: ${body.error ?? "unknown error"}`,
    oracle || fallbackFamily ? null : `Could not load the catalogue oracle for ${expected}`,
    returned.length > 0 ? null : "The image produced no catalogue suggestions",
    relevant.length > 0 ? null : `No returned item was relevant to ${oracle?.name ?? expected}`,
    relevant.every((product) => product.list_price > 0) ? null : "A returned item has no positive catalogue price",
    returned.length === relevant.length ? null : "The response included a different product family",
    claimsExactWithoutEvidence ? "The response claimed an exact identification without a visible verified SKU" : null,
    responseMessage ? null : `The response did not match the chat contract: ${body.error ?? "missing message"}`,
    responseMessage.toLowerCase().includes("qa-pixel-only") ? "The response leaked or used the neutral upload filename" : null,
  ].filter(Boolean);

  return {
    file: filePath,
    sentName: `qa-pixel-only-upload-${index + 1}.jpg`,
    sentMessage,
    expected,
    oracle,
    pass: failures.length === 0,
    failures,
    durationMs,
    message: body.message,
    selectedProduct: body.selectedProduct,
    products: body.products,
  };
}

async function validateComparisonScreenshot(message: string, expectedQuantity: RegExp, label: string) {
  const bytes = await fs.readFile(comparisonScreenshot);
  const { status, body, durationMs } = await postChat({
    message,
    image: {
      dataUrl: `data:${mimeTypeFor(comparisonScreenshot)};base64,${bytes.toString("base64")}`,
      mimeType: mimeTypeFor(comparisonScreenshot),
      name: `qa-${label}.png`,
    },
  });
  const responseMessage = body.message ?? "";
  const productText = (body.products ?? []).map((product) => `${product.stock_id} ${product.name}`).join(" ");
  const combined = `${responseMessage} ${productText}`;
  const requiredDetails = ["WF-RD-10", "WF-RD-30", "10 kg", "30 kg"];
  const failures = [
    durationMs < 10_000 ? null : `Reply took ${durationMs}ms; expected under 10000ms`,
    status === 200 ? null : `HTTP ${status}: ${body.error ?? "unknown error"}`,
    expectedQuantity.test(responseMessage) ? null : "The comparison screenshot lost the requested quantity",
    /automatic rice dispensers/i.test(responseMessage)
      ? null
      : "The clear comparison screenshot was not identified as automatic rice dispensers",
    ...requiredDetails.map((detail) => responseMessage.includes(detail)
      ? null
      : `The comparison response omitted the visible detail: ${detail}`),
    label === "comparison-numbered" && /WF-RD-60/i.test(responseMessage)
      ? "The numbered request for items 1 and 2 incorrectly included item 3 (WF-RD-60)"
      : null,
    /can['’]?t reliably read|closer crop|unreadable/i.test(responseMessage)
      ? "The bot asked for another image even though this verified fixture is readable"
      : null,
    !/utility box|cambox|storage box/i.test(combined)
      ? null
      : "The rice-dispenser comparison screenshot was misclassified as a utility/storage box",
    (body.products?.length ?? 0) === 0
      ? null
      : "The unresolved comparison screenshot returned unverified catalogue product cards",
  ].filter(Boolean);

  return {
    file: comparisonScreenshot,
    sentName: `qa-${label}.png`,
    expected: "rice-dispenser comparison screenshot",
    oracle: null,
    pass: failures.length === 0,
    failures,
    durationMs,
    message: responseMessage,
    selectedProduct: body.selectedProduct,
    products: body.products,
  };
}

async function validateRandomNonProduct() {
  const bytes = await fs.readFile(randomNonProductImage);
  const { status, body, durationMs } = await postChat({
    message: "Can you help me buy this? I need 3.",
    image: {
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
      mimeType: "image/png",
      name: "qa-random-upload.png",
    },
  });
  const responseMessage = body.message ?? "";
  const failures = [
    durationMs < 30_000 ? null : `Reply took ${durationMs}ms; expected under 30000ms`,
    status === 200 ? null : `HTTP ${status}: ${body.error ?? "unknown error"}`,
    /(?:kept|quantity|need)[^.!?]{0,30}\b3\b|\b3\b[^.!?]{0,30}(?:units?|each)/i.test(responseMessage)
      ? null
      : "The random-image response lost quantity 3",
    /can['’]?t (?:identify|read)|item name|key detail|clearer|staff review/i.test(responseMessage)
      ? null
      : "The random-image response did not give a useful recovery step",
    (body.products?.length ?? 0) === 0 && !body.selectedProduct
      ? null
      : "A random non-product image returned purchasable product cards",
  ].filter(Boolean);

  return {
    file: randomNonProductImage,
    sentName: "qa-random-upload.png",
    expected: "safe non-product clarification",
    oracle: null,
    pass: failures.length === 0,
    failures,
    durationMs,
    message: responseMessage,
    selectedProduct: body.selectedProduct,
    products: body.products,
  };
}

async function validateRandomNonProductWithNamedCategory() {
  const bytes = await fs.readFile(randomNonProductImage);
  const { status, body, durationMs } = await postChat({
    message: "Need 2 storage boxes like this.",
    image: {
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
      mimeType: "image/png",
      name: "qa-random-named-category.png",
    },
  });
  const responseMessage = body.message ?? "";
  const failures = [
    durationMs < 30_000 ? null : `Reply took ${durationMs}ms; expected under 30000ms`,
    status === 200 ? null : `HTTP ${status}: ${body.error ?? "unknown error"}`,
    /(?:kept|quantity|need)[^.!?]{0,30}\b2\b|\b2\b[^.!?]{0,30}(?:units?|each)/i.test(responseMessage)
      ? null
      : "The named-category random-image response lost quantity 2",
    /storage\s+box|item name|key detail|clearer|staff review/i.test(responseMessage)
      ? null
      : "The named-category random-image response did not preserve the category and give a useful recovery step",
    (body.products?.length ?? 0) === 0 && !body.selectedProduct
      ? null
      : "A random image plus a generic named category bypassed visual safety and returned product cards",
  ].filter(Boolean);

  return {
    file: randomNonProductImage,
    sentName: "qa-random-named-category.png",
    expected: "safe named-category clarification",
    oracle: null,
    pass: failures.length === 0,
    failures,
    durationMs,
    message: responseMessage,
    selectedProduct: body.selectedProduct,
    products: body.products,
  };
}

async function validateRandomNonProductWithRememberedCategory() {
  const bytes = await fs.readFile(randomNonProductImage);
  const { status, body, durationMs } = await postChat({
    message: "Need 2.",
    history: [
      { role: "user", content: "I am looking for storage boxes." },
      { role: "assistant", content: "I can help with storage boxes. Send the size or a product photo." },
    ],
    image: {
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
      mimeType: "image/png",
      name: "qa-random-remembered-category.png",
    },
  });
  const responseMessage = body.message ?? "";
  const failures = [
    durationMs < 30_000 ? null : `Reply took ${durationMs}ms; expected under 30000ms`,
    status === 200 ? null : `HTTP ${status}: ${body.error ?? "unknown error"}`,
    /(?:kept|quantity|need)[^.!?]{0,30}\b2\b|\b2\b[^.!?]{0,30}(?:units?|each)/i.test(responseMessage)
      ? null
      : "The remembered-category random-image response lost quantity 2",
    /storage\s+box|item name|key detail|clearer|staff review/i.test(responseMessage)
      ? null
      : "The remembered-category response did not give a useful next step",
    (body.products?.length ?? 0) === 0 && !body.selectedProduct
      ? null
      : "A generic follow-up plus a remembered category bypassed visual safety and returned product cards",
  ].filter(Boolean);

  return {
    file: randomNonProductImage,
    sentName: "qa-random-remembered-category.png",
    expected: "safe remembered-category clarification",
    oracle: null,
    pass: failures.length === 0,
    failures,
    durationMs,
    message: responseMessage,
    selectedProduct: body.selectedProduct,
    products: body.products,
  };
}

async function main() {
  const results = [];
  for (let index = 0; index < fixtures.length; index += 1) {
    results.push(await validateImage(fixtures[index], index));
  }
  results.push(await validateComparisonScreenshot(
    "Do you have this? I need 2.",
    /(?:kept|quantity|need)[^.!?]{0,30}\b2\b|\b2\b[^.!?]{0,30}(?:units?|each)/i,
    "comparison-general",
  ));
  results.push(await validateComparisonScreenshot(
    "Can you check items 1 and 2? I need 2 each.",
    /\b2\s+each\b|kept[^.!?]{0,30}\b2\b/i,
    "comparison-numbered",
  ));
  results.push(await validateComparisonScreenshot(
    "Compare the rice dispensers in this screenshot; I need 2.",
    /(?:kept|quantity|need)[^.!?]{0,30}\b2\b|\b2\b[^.!?]{0,30}(?:units?|each)/i,
    "comparison-explicit-family",
  ));
  results.push(await validateRandomNonProduct());
  results.push(await validateRandomNonProductWithNamedCategory());
  results.push(await validateRandomNonProductWithRememberedCategory());

  const pass = results.filter((result) => result.pass).length;
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl: qaBaseUrl,
    total: results.length,
    pass,
    fail: results.length - pass,
    results,
  };
  const reportPath = await writeQaReport("image-regression.json", report);
  if (process.env.QA_SILENT !== "1") {
    console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  }
  process.exitCode = report.fail === 0 ? 0 : 1;
}

void main();
