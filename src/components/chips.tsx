// Status chips: always a symbol AND a word, never colour alone (WCAG 1.4.1).
import clsx from "clsx";
import type { ClaimState, Coverage, RoleKey, Trust } from "@/lib/types";

type Tone = "ok" | "warn" | "bad" | "hold" | "info" | "plain";

const TONE: Record<Tone, string> = {
  ok: "border-ok/40 text-ok bg-[#e9f1ec]",
  warn: "border-warn/40 text-warn bg-[#f6eedb]",
  bad: "border-bad/40 text-bad bg-[#f6e6e7]",
  hold: "border-hold/40 text-hold bg-[#eceef0]",
  info: "border-attest/40 text-attest bg-[#e7edf4]",
  plain: "border-rule-strong text-ink-2 bg-card",
};

export function Chip({ symbol, label, tone = "plain", title }: { symbol: string; label: string; tone?: Tone; title?: string }) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium leading-5",
        TONE[tone],
      )}
    >
      <span aria-hidden="true">{symbol}</span>
      {label}
    </span>
  );
}

export const TRUST_LABEL: Record<Trust, string> = {
  from_record: "From record",
  corroborated: "Corroborated",
  leaver_said: "Leaver said",
  second_hand: "Second-hand",
  inferred: "Inferred",
  ranked_options: "Ranked options",
};

const TRUST_STYLE: Record<Trust, { symbol: string; tone: Tone }> = {
  from_record: { symbol: "◆", tone: "ok" },
  corroborated: { symbol: "◆◆", tone: "ok" },
  leaver_said: { symbol: "❝", tone: "info" },
  second_hand: { symbol: "↪", tone: "warn" },
  inferred: { symbol: "≈", tone: "warn" },
  ranked_options: { symbol: "⋯", tone: "hold" },
};

export function TrustChip({ trust }: { trust: Trust }) {
  const s = TRUST_STYLE[trust];
  return <Chip symbol={s.symbol} label={TRUST_LABEL[trust]} tone={s.tone} />;
}

const STATE_STYLE: Record<ClaimState, { symbol: string; label: string; tone: Tone }> = {
  active: { symbol: "●", label: "Active", tone: "plain" },
  superseded: { symbol: "⤓", label: "Superseded", tone: "hold" },
  conflicting: { symbol: "⇄", label: "Conflicting", tone: "bad" },
  dropped: { symbol: "✕", label: "Dropped", tone: "bad" },
};

export function StateChip({ state, note }: { state: ClaimState; note?: string | null }) {
  const s = STATE_STYLE[state];
  return <Chip symbol={s.symbol} label={s.label} tone={s.tone} title={note ?? undefined} />;
}

export const COVERAGE_LABEL: Record<Coverage, string> = {
  covered: "Covered",
  partial: "Partial",
  missing: "Missing",
  restricted: "Restricted",
  conflicting: "Conflicting",
};

const COVERAGE_STYLE: Record<Coverage, { symbol: string; tone: Tone }> = {
  covered: { symbol: "✓", tone: "ok" },
  partial: { symbol: "◐", tone: "warn" },
  missing: { symbol: "○", tone: "bad" },
  restricted: { symbol: "⊘", tone: "hold" },
  conflicting: { symbol: "⇄", tone: "bad" },
};

export function CoverageChip({ coverage }: { coverage: Coverage }) {
  const s = COVERAGE_STYLE[coverage];
  return <Chip symbol={s.symbol} label={COVERAGE_LABEL[coverage]} tone={s.tone} />;
}

export function RoleChip({ label, role }: { label: string; role: RoleKey }) {
  return (
    <span className="inline-flex items-center rounded border border-rule bg-paper-2 px-1.5 text-xs leading-5 text-ink-2" data-role={role}>
      {label}
    </span>
  );
}

export function TierChip({ tier }: { tier: "A" | "B" | "C" }) {
  const map: Record<"A" | "B" | "C", { label: string; tone: Tone }> = {
    A: { label: "Tier A · bulk", tone: "ok" },
    B: { label: "Tier B · one by one", tone: "plain" },
    C: { label: "Tier C · needs a reason", tone: "warn" },
  };
  return <Chip symbol={tier === "C" ? "!" : "▤"} label={map[tier].label} tone={map[tier].tone} />;
}
