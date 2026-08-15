import { Check, Database, MessageCircleMore, ShieldCheck } from "lucide-react";
import { ChatDemo } from "@/components/chat-demo";

const features = [
  { icon: Database, title: "Complete website catalogue", copy: "Search all public items by code, name, brand or specification." },
  { icon: ShieldCheck, title: "Live stock checkpoint", copy: "Rechecks the Sia Huat listing after the customer confirms an item." },
  { icon: MessageCircleMore, title: "Human review ready", copy: "Drafts a clear reply before it reaches WhatsApp." },
];

export default function Home() {
  return <main className="min-h-dvh bg-[#f5f1e8] text-[#15362f] lg:h-dvh lg:overflow-hidden">
    <div className="mx-auto grid min-h-dvh min-w-0 max-w-[1440px] items-center gap-10 px-3 py-6 sm:px-6 sm:py-8 lg:h-full lg:min-h-0 lg:grid-cols-[1.08fr_.92fr] lg:px-12 lg:py-6 xl:px-20">
      <section className="mx-auto min-w-0 w-full max-w-2xl lg:mx-0">
        <div className="mb-7 flex items-center gap-3"><div className="grid size-12 place-items-center rounded-2xl bg-[#ef6b3b] text-sm font-bold text-white shadow-lg">HL</div><div><p className="font-semibold">Hi-Lite × Sia Huat</p><p className="text-xs text-[#5e746d]">Phase 1 product enquiry demo</p></div></div>
        <p className="mb-4 text-xs font-bold uppercase tracking-[.24em] text-[#df5c30]">AI sales enquiry assistant</p>
        <h1 className="max-w-[700px] text-[clamp(2.35rem,12vw,5.8rem)] font-semibold leading-[.94] tracking-[-.055em] sm:leading-[.91] sm:tracking-[-.065em]">Turn product questions into ready-to-review quotes.</h1>
        <p className="mt-5 max-w-xl text-base leading-7 text-[#60736d] xl:text-lg xl:leading-8">An n8n-powered WhatsApp-style assistant that searches Sia Huat’s public catalogue, verifies the selected item live, and prepares a grounded reply for the sales team.</p>
        <div className="mt-7 divide-y divide-[#15362f]/12 border-y border-[#15362f]/12">{features.map(({ icon: Icon, title, copy }) => <div key={title} className="grid grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-3 py-3.5 xl:py-4"><div className="grid size-9 place-items-center rounded-full bg-white/70 text-[#df5c30]"><Icon className="size-4" /></div><div className="min-w-0"><h2 className="font-semibold">{title}</h2><p className="text-sm text-[#6a7d77]">{copy}</p></div><Check className="size-4 text-[#2d8a6c]" /></div>)}</div>
        <p className="mt-4 text-xs text-[#7a8984]">Demo responses require human approval before customer delivery.</p>
      </section>
      <section className="flex min-w-0 w-full justify-center lg:justify-end" aria-label="Product assistant demo"><ChatDemo /></section>
    </div>
  </main>;
}
