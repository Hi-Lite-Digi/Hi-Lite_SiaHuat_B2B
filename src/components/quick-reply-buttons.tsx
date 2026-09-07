"use client";

type Choice = { value: string; label: string };

export function QuickReplyButtons({ choices, onChoose, disabled = false }: {
  choices: Choice[];
  onChoose: (value: string) => void;
  disabled?: boolean;
}) {
  if (!choices.length) return null;
  return <div className="chat-suggestions print-hide mt-1.5 grid gap-1.5" role="group" aria-label="Suggested replies">
    {choices.map(choice => <button key={choice.value} type="button" disabled={disabled}
      onClick={() => onChoose(choice.value)}
      className="min-h-11 w-full rounded-xl border border-[#176853]/15 bg-white px-4 py-3 text-center text-sm font-semibold leading-5 text-[#176853] shadow-sm transition-colors hover:bg-[#edf7f1] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#176853] disabled:cursor-not-allowed disabled:opacity-50">
      {choice.label}
    </button>)}
  </div>;
}
