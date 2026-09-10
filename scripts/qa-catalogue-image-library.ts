import dotenv from "dotenv";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import sharp from "sharp";
import { lookupCatalogueImage } from "../src/lib/catalogue-image-library";
import { catalogueImageFingerprint } from "../src/lib/catalogue-image-fingerprint";
dotenv.config({ path: ".env.local", quiet: true });

async function main() {
  const products = JSON.parse(await readFile("tmp/catalogue-images/products.json", "utf8")) as Array<{stock_id:string;name:string;image_url:string}>;
  const sourcePath = (url:string) => `tmp/catalogue-images/${createHash("sha256").update(url).digest("hex")}.source`;
  const available = products.filter(p => p.image_url && existsSync(sourcePath(p.image_url)));
  const selected = new Map<string, typeof products[number]>();
  for (const code of ["CSD16C", "CB-TC-CKWH", "GAS", "1000LCD-131", "500LCD-131"]) {
    const p = available.find(p => p.stock_id === code); if(p) selected.set(p.image_url,p);
  }
  for (const pattern of [/\bchef.*knife/i,/\bplate\b/i,/\bglass\b/i,/\bbowl\b/i,/\bladle\b/i,/\bstrainer\b/i,/frying.*pan/i,/\bjug\b/i,/\bbox\b/i,/\bspoon\b/i,/\bfork\b/i,/\btongs\b/i]) {
    const p=available.find(p=>pattern.test(p.name)&&!selected.has(p.image_url)); if(p)selected.set(p.image_url,p);
  }
  const results=[];
  for(const product of selected.values()) {
    const original=await readFile(sourcePath(product.image_url));
    const fp=await catalogueImageFingerprint(original);
    if(!fp.searchable) { console.log(JSON.stringify({code:product.stock_id,skipped:"low-detail reference"}));continue; }
    const resized=await sharp(original).resize(480,480,{fit:"inside"}).jpeg({quality:78}).toBuffer();
    const border=await sharp(resized).extend({top:20,bottom:20,left:20,right:20,background:"white"}).extend({top:1,bottom:1,left:1,right:1,background:"#777777"}).png().toBuffer();
    for(const [variant,bytes] of [["original",original],["resized-jpeg",resized],["screenshot-border",border]] as const) {
      const start=performance.now();
      const result=await lookupCatalogueImage({dataUrl:`data:image/${variant==="resized-jpeg"?"jpeg":"png"};base64,${bytes.toString("base64")}`,mimeType:variant==="resized-jpeg"?"image/jpeg":"image/png",name:"qa-photo"});
      const ids=result?.matches.flatMap(match=>match.stockIds)??[];
      const found=ids.includes(product.stock_id);
      const row={code:product.stock_id,name:product.name,variant,found,kind:result?.kind??"none",score:result?.matches[0]?.score??null,ids,elapsedMs:Math.round(performance.now()-start)};
      results.push(row);console.log(JSON.stringify(row));
    }
  }
  const negatives: Array<{name:string; bytes:Buffer}> = [{name:"blank",bytes:await sharp({create:{width:500,height:500,channels:3,background:"white"}}).png().toBuffer()}];
  if(existsSync("tmp/qa-reports/outdoor-stove-reference.jpg")) negatives.push({name:"alternate stove photo requiring vision",bytes:await readFile("tmp/qa-reports/outdoor-stove-reference.jpg")});
  const negativeResults=[];
  for(const fixture of negatives) {
    const result=await lookupCatalogueImage({dataUrl:`data:image/png;base64,${fixture.bytes.toString("base64")}`,mimeType:"image/png",name:fixture.name});
    const row={name:fixture.name,kind:result?.kind??"none",safe:!result||result.kind==="candidates"};
    negativeResults.push(row);console.log(JSON.stringify(row));
  }
  const summary={checked:results.length,found:results.filter(r=>r.found).length,misses:results.filter(r=>!r.found),results,negativeResults};
  await mkdir("tmp/qa-reports",{recursive:true});
  await writeFile("tmp/qa-reports/catalogue-image-library.json",JSON.stringify(summary,null,2));
  console.log(JSON.stringify({checked:summary.checked,found:summary.found,misses:summary.misses.length}));
  if(summary.misses.length || negativeResults.some(r=>!r.safe))process.exitCode=1;
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
