import type { EventSummary, SponsorSummary } from "./types";

interface VoucherHeaderProps {
  event: EventSummary;
  sponsor: SponsorSummary;
}

export function VoucherHeader({ event, sponsor }: VoucherHeaderProps) {
  return (
    <header className="voucher-header">
      <div className="voucher-logo voucher-logo--text" aria-label="Event Voucher">
        QR
      </div>
      <div className="voucher-event">
        <h1>{event.name}</h1>
        <time dateTime={event.eventDate}>{formatEventDate(event.eventDate)}</time>
      </div>
      <span className="voucher-accent" aria-hidden="true" />
      <h2>{sponsor.name}</h2>
    </header>
  );
}

function formatEventDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return value;
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return new Intl.DateTimeFormat("de-DE", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
