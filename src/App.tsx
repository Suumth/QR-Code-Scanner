import "./app.css";
import { AdminPage } from "./features/admin/AdminPage";
import { PublicVoucherPage } from "./features/sponsor/PublicVoucherPage";
import { SponsorPage } from "./features/sponsor/SponsorPage";
import { HomeTeamEntry } from "./features/team/HomeTeamEntry";
import { TeamLoginPage } from "./features/team/TeamLoginPage";

export default function App() {
  if (/^\/?$/.test(window.location.pathname)) {
    return <HomeTeamEntry />;
  }

  if (/^\/admin\/?$/.test(window.location.pathname)) {
    return <AdminPage />;
  }

  const teamMatch = /^\/team\/([^/]+)\/?$/.exec(window.location.pathname);
  if (teamMatch) {
    return <TeamLoginPage eventPublicId={teamMatch[1]} />;
  }

  const sponsorMatch = /^\/s\/([^/]+)\/?$/.exec(window.location.pathname);
  if (sponsorMatch) {
    return <SponsorPage accessId={sponsorMatch[1]} />;
  }

  const voucherMatch = /^\/v\/([^/]+)\/?$/.exec(window.location.pathname);
  if (voucherMatch) {
    return <PublicVoucherPage publicId={voucherMatch[1]} />;
  }

  return (
    <main className="app-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Event Voucher Startseite">
          <span className="brand-mark" aria-hidden="true">QR</span>
          <span>Event Voucher</span>
        </a>
      </header>

      <section className="intro" aria-labelledby="voucher-title">
        <h1 id="voucher-title">Digitale Getränkegutscheine</h1>
        <p className="lead">
          Gutscheine ausgeben, vor Ort prüfen und sicher einlösen – direkt im
          Browser.
        </p>
      </section>

      <footer className="site-footer">Event Voucher</footer>
    </main>
  );
}
