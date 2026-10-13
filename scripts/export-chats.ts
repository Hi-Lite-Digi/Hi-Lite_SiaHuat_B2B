import dotenv from "dotenv";
import { writeFile } from "node:fs/promises";
import { Client } from "pg";
import { getDatabaseUrl } from "./database-url";

// Saves the chat turns the live site logged (chat_turns) as a spreadsheet on the Desktop, one row per turn, grouped by chat.
//   pnpm chats:export                      every chat
//   pnpm chats:export --since 2026-10-13   chats from that day on (Singapore time)
type Turn = {
  created_at: Date; session_id: string; customer: string; claire: string; cards: string[]; chips: string[];
  show_contact: boolean; enquiry: Array<{ code: string; quantity: number }>;
};

dotenv.config({ path: ".env.local", quiet: true });

// Quoted, with quotes doubled, so commas and line breaks in a message stay inside its cell.
const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
const sgt = (date: Date) => date.toLocaleString("en-SG", { timeZone: "Asia/Singapore", hour12: false });

async function main() {
  const at = process.argv.indexOf("--since");
  const since = at > 0 ? `${process.argv[at + 1]}T00:00:00+08:00` : "1970-01-01T00:00:00Z";
  const client = new Client({ connectionString: getDatabaseUrl() });
  await client.connect();
  try {
    const { rows } = await client.query<Turn>(
      "select created_at, session_id, customer, claire, cards, chips, show_contact, enquiry from public.chat_turns where created_at >= $1 order by session_id, created_at",
      [since],
    );
    const table = [
      ["Time (SGT)", "Chat", "Customer", "Claire", "Cards", "Chips", "Contact shown", "Enquiry after"],
      ...rows.map((turn) => [
        sgt(turn.created_at), turn.session_id.slice(-8), turn.customer, turn.claire, turn.cards.join(" "), turn.chips.join(" | "),
        turn.show_contact ? "yes" : "", turn.enquiry.map((line) => `${line.code} x${line.quantity}`).join(", "),
      ]),
    ];
    const file = `${process.env.USERPROFILE ?? "."}/Desktop/sia-huat-chats-${new Date().toISOString().slice(0, 10)}.csv`;
    // The byte-order mark makes Excel read the file as UTF-8, so Chinese and symbols like Ø show correctly.
    await writeFile(file, `﻿${table.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`);
    console.log(`Wrote ${rows.length} turns from ${new Set(rows.map((turn) => turn.session_id)).size} chats to ${file}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
