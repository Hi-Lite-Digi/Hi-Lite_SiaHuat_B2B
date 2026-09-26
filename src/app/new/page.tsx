// src/app/new/page.tsx
import { AgentChat } from "@/components/agent-chat";

export const metadata = { title: "Claire (new version, test) | Hi-Lite × Sia Huat" };

export default function NewClairePage() {
  return <main className="flex min-h-dvh items-center justify-center bg-[#f5f1e8] px-3 py-4 text-[#15362f]">
    <AgentChat />
  </main>;
}
