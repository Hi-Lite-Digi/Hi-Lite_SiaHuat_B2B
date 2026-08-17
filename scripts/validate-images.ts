import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { postChat, qaBaseUrl, writeQaReport } from "./qa-utils";

const defaultFixtures = [
  "D:/Downloades/101CA-1000LCD.jpg",
  "D:/Downloades/101CA-1520CBP-110.jpg",
];
const fixtures = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : defaultFixtures;

function expectedStockId(filePath: string) {
  return path.basename(filePath, path.extname(filePath)).toUpperCase();
}

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
    return /camtainer|beverage dispenser|drink dispenser|tea dispenser/.test(candidate);
  }
  if (/utility box|cambox|storage box/.test(expected)) {
    return /utility box|cambox|storage box|container|storage bin/.test(candidate);
  }

  const expectedWords = words(expectedName);
  return [...words(candidateName)].filter((word) => expectedWords.has(word)).length >= 2;
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

async function validateImage(filePath: string, index: number) {
  const bytes = await fs.readFile(filePath);
  const expected = expectedStockId(filePath);
  const oracle = await getOracleProduct(expected);
  const { status, body, durationMs } = await postChat({
    message: "Do you sell this? Please identify it and show the SKU and catalogue price.",
    image: {
      dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
      mimeType: "image/jpeg",
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
    : [];
  const responseMessage = typeof body.message === "string" ? body.message : "";
  const positiveExactClaim = /\b(this is|identified as|exactly matches|confirmed as|definitely)\b/i.test(responseMessage);
  const qualifiedAsSuggestion = /\b(suggest|possible|likely|looks like|could be|appears to be)\b/i.test(responseMessage);
  const claimsExactWithoutEvidence = positiveExactClaim && !qualifiedAsSuggestion;
  const failures = [
    durationMs < 30_000 ? null : `Reply took ${durationMs}ms; expected under 30000ms`,
    status === 200 ? null : `HTTP ${status}: ${body.error ?? "unknown error"}`,
    oracle ? null : `Could not load the catalogue oracle for ${expected}`,
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

async function main() {
  const results = [];
  for (let index = 0; index < fixtures.length; index += 1) {
    results.push(await validateImage(fixtures[index], index));
  }

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
