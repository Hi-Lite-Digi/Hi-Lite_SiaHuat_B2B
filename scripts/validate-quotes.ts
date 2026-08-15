import dotenv from "dotenv";
import { postChat, writeQaReport } from "./qa-utils";
import type { ChatReply, Product } from "../src/lib/chat-contract";

dotenv.config({ path: ".env.local", quiet: true });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function loadSourceProducts(stockIds: string[]) {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert(url && serviceKey, "Supabase REST credentials are missing");
  const ids = stockIds.map((value) => `"${value.replaceAll('"', '\\"')}"`).join(",");
  const endpoint = new URL("/rest/v1/products", url);
  endpoint.searchParams.set("select", "stock_id,name,status,list_price,uom_id");
  endpoint.searchParams.set("stock_id", `in.(${ids})`);
  const response = await fetch(endpoint, {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `Supabase REST returned ${response.status}`);
  return await response.json() as Product[];
}

async function main() {
  const apiResponse = await postChat({
    sessionId: `quote-validation-${crypto.randomUUID()}`,
    message: "chef knife",
  });
  assert(apiResponse.status === 200, `Chat API returned ${apiResponse.status}`);
  const reply = apiResponse.body as ChatReply;
  assert(reply.stage === "clarify", `Expected clarify stage, received ${reply.stage}`);
  assert(reply.selectedProduct === null, "API selected a product before customer confirmation");
  assert(reply.products.length > 0, "No chef-knife products were returned");

  const stockIds = reply.products.map((product) => product.stock_id);
  const source = await loadSourceProducts(stockIds);
  const sourceByStockId = new Map(source.map((product) => [product.stock_id, product]));

    const comparisons = reply.products.map((product) => {
      const row = sourceByStockId.get(product.stock_id);
      assert(row, `API product ${product.stock_id} does not exist in public.products`);
      assert(row.name === product.name, `Name mismatch for ${product.stock_id}`);
      assert(row.status === product.status, `Status mismatch for ${product.stock_id}`);
      assert(row.list_price === product.list_price, `Price mismatch for ${product.stock_id}`);
      assert(row.uom_id === product.uom_id, `UOM mismatch for ${product.stock_id}`);
      return { stock_id: product.stock_id, price: product.list_price, uom: product.uom_id, sourceMatch: true };
    });

    const selected = reply.products.find((product) => product.stock_id === "119XX-100-224") ?? reply.products[0];
    const quantity = 5;
    const computedTotal = Number((selected.list_price * quantity).toFixed(2));
    const sourceSelected = sourceByStockId.get(selected.stock_id);
    assert(sourceSelected, "Selected product disappeared during arithmetic verification");
    const sourceTotal = Number((quantity * Number(sourceSelected.list_price)).toFixed(2));
    assert(computedTotal === sourceTotal, "Chat and Supabase totals differ");

    const report = {
      result: "PASS",
      query: "chef knife",
      productCount: reply.products.length,
      comparisons,
      arithmetic: {
        stock_id: selected.stock_id,
        quantity,
        unitPrice: selected.list_price,
        uom: selected.uom_id,
        computedTotal,
        databaseTotal: sourceTotal,
      },
      confirmationGate: { stage: reply.stage, selectedProduct: reply.selectedProduct },
    };
    const reportPath = await writeQaReport("quote-regression.json", report);
    if (process.env.QA_SILENT !== "1") {
      console.log(JSON.stringify({ ...report, reportPath }, null, 2));
    }
}

void main();
