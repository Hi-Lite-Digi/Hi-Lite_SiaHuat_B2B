import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { writeQaReport } from "./qa-utils";

const iterations = Number.parseInt(process.env.QA_ITERATIONS ?? "20", 10);
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100) {
  throw new Error("QA_ITERATIONS must be a whole number between 1 and 100");
}

function runQaIteration() {
  const isWindows = process.platform === "win32";
  const command = isWindows ? process.env.ComSpec ?? "cmd.exe" : "pnpm";
  const args = isWindows ? ["/d", "/s", "/c", "pnpm qa:all"] : ["qa:all"];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, QA_SILENT: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout.on("data", () => {
      // Drain the child stream so repeated runs cannot block on a full pipe.
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `QA process exited with code ${code}`));
    });
  });
}

async function readReport(name: string) {
  const reportPath = path.resolve("tmp", "qa-reports", name);
  return JSON.parse(await fs.readFile(reportPath, "utf8")) as { pass?: number; fail?: number; result?: string };
}

async function main() {
  const runs = [];
  for (let index = 1; index <= iterations; index += 1) {
    const started = performance.now();
    try {
      await runQaIteration();
      const [text, image, quote] = await Promise.all([
        readReport("text-regression.json"),
        readReport("image-regression.json"),
        readReport("quote-regression.json"),
      ]);
      runs.push({
        iteration: index,
        pass: text.fail === 0 && image.fail === 0 && quote.result === "PASS",
        durationMs: Math.round(performance.now() - started),
        text,
        image,
        quote: quote.result,
      });
    } catch (error) {
      runs.push({
        iteration: index,
        pass: false,
        durationMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
    console.log(`QA iteration ${index}/${iterations}: PASS`);
  }

  const passedRuns = runs.filter((run) => run.pass).length;
  const report = {
    generatedAt: new Date().toISOString(),
    requestedIterations: iterations,
    completedIterations: runs.length,
    pass: passedRuns,
    fail: runs.length - passedRuns,
    runs,
  };
  const reportPath = await writeQaReport("repeated-regression.json", report);
  console.log(JSON.stringify({
    requestedIterations: report.requestedIterations,
    completedIterations: report.completedIterations,
    pass: report.pass,
    fail: report.fail,
    reportPath,
  }, null, 2));
  process.exitCode = passedRuns === iterations ? 0 : 1;
}

void main();
