import { useState, type FormEvent, type ReactNode } from "react";

import type {
  AdminEvent,
  AdminEventDetail,
  AdminSponsor,
  AdminVoucherType,
  AdminTeamSessionStatus,
  CreateEventInput,
} from "./types";

interface AdminDashboardProps {
  events: AdminEvent[];
  selectedEventId: string | null;
  detail: AdminEventDetail | null;
  detailLoading: boolean;
  detailLoadFailed: boolean;
  busy: boolean;
  sponsorsLoading: boolean;
  notice?: { kind: "success" | "error"; message: string };
  onSelectEvent(eventId: string): void;
  onRetryEvent(): void;
  onCreateEvent(input: CreateEventInput): Promise<boolean>;
  onCreateSponsor(name: string): Promise<boolean>;
  onCreateVoucherType(sponsorId: string, name: string): Promise<boolean>;
  onIssueVouchers(sponsorId: string, voucherTypeId: string, count: number): Promise<boolean>;
  onCopySponsorLink(sponsor: AdminSponsor): Promise<boolean>;
  onDownloadQrPackage(sponsor: AdminSponsor, voucherType: AdminVoucherType): Promise<boolean>;
  onLoadMoreSponsors(): Promise<void>;
  onChangePin(pin: string): Promise<boolean>;
  onRevokeSessions(): Promise<boolean>;
  onDownloadCsv(): Promise<void>;
  onLogout(): Promise<void>;
}

const eventDateFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "long",
  timeZone: "UTC",
});
const timestampFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "short",
  timeStyle: "short",
});

export function AdminDashboard(props: AdminDashboardProps) {
  const selectedEvent = props.detail?.event ??
    props.events.find((event) => event.id === props.selectedEventId) ??
    null;

  return (
    <main className="admin-shell">
      <AdminHeader
        csvDisabled={!props.detail || props.busy || props.sponsorsLoading}
        logoutDisabled={props.busy}
        onDownloadCsv={() => void props.onDownloadCsv()}
        onLogout={() => void props.onLogout()}
      />
      <div className="admin-page">
        <EventSwitcher
          events={props.events}
          selectedEventId={props.selectedEventId}
          disabled={props.busy}
          onSelectEvent={props.onSelectEvent}
        />

        <CreateEventForm
          initiallyOpen={props.events.length === 0}
          disabled={props.busy || props.sponsorsLoading}
          onCreate={props.onCreateEvent}
        />

        {props.notice ? (
          <p
            className={`admin-notice admin-notice--${props.notice.kind}`}
            role={props.notice.kind === "error" ? "alert" : "status"}
            aria-live={props.notice.kind === "error" ? "assertive" : "polite"}
          >
            {props.notice.message}
          </p>
        ) : null}

        {props.events.length === 0 ? (
          <section className="admin-empty" aria-labelledby="admin-empty-title">
            <h1 id="admin-empty-title">Noch kein Event</h1>
            <p>Lege das erste Event mit Datum und Team-PIN an.</p>
          </section>
        ) : props.detailLoadFailed && selectedEvent ? (
          <section className="admin-empty">
            <h1>{selectedEvent.name}</h1>
            <p>Eventdaten konnten nicht geladen werden.</p>
            <button className="admin-primary" type="button" onClick={props.onRetryEvent}>
              Eventdaten erneut laden
            </button>
          </section>
        ) : props.detailLoading || !props.detail || !selectedEvent ? (
          <section className="admin-empty" aria-live="polite">
            <h1>{selectedEvent?.name ?? "Event wird geladen"}</h1>
            <p>Eventdaten werden geladen …</p>
          </section>
        ) : (
          <EventDetail
            key={props.detail.event.id}
            detail={props.detail}
            disabled={props.busy || props.sponsorsLoading}
            sponsorsLoading={props.sponsorsLoading}
            onCreateSponsor={props.onCreateSponsor}
            onCreateVoucherType={props.onCreateVoucherType}
            onIssueVouchers={props.onIssueVouchers}
            onCopySponsorLink={props.onCopySponsorLink}
            onDownloadQrPackage={props.onDownloadQrPackage}
            onLoadMoreSponsors={props.onLoadMoreSponsors}
            onChangePin={props.onChangePin}
            onRevokeSessions={props.onRevokeSessions}
          />
        )}
      </div>
    </main>
  );
}

function AdminHeader({
  csvDisabled,
  logoutDisabled,
  onDownloadCsv,
  onLogout,
}: {
  csvDisabled: boolean;
  logoutDisabled: boolean;
  onDownloadCsv(): void;
  onLogout(): void;
}) {
  return (
    <header className="admin-header">
      <a href="/" aria-label="Event Voucher Startseite">
        <span className="brand-mark" aria-label="Event Voucher">QR</span>
      </a>
      <div className="admin-header-actions">
        <button type="button" disabled={csvDisabled} onClick={onDownloadCsv}>
          <DownloadIcon />
          CSV exportieren
        </button>
        <button type="button" disabled={logoutDisabled} onClick={onLogout}>
          <LogoutIcon />
          Abmelden
        </button>
      </div>
    </header>
  );
}

function EventSwitcher({
  events,
  selectedEventId,
  disabled,
  onSelectEvent,
}: {
  events: AdminEvent[];
  selectedEventId: string | null;
  disabled: boolean;
  onSelectEvent(eventId: string): void;
}) {
  if (events.length === 0) {
    return null;
  }
  return (
    <nav className="admin-events" aria-label="Events auswählen">
      {events.map((event) => (
        <button
          key={event.id}
          type="button"
          aria-current={event.id === selectedEventId ? "page" : undefined}
          disabled={disabled}
          onClick={() => onSelectEvent(event.id)}
        >
          <span>{event.name}</span>
          <time dateTime={event.eventDate}>{formatEventDate(event.eventDate)}</time>
        </button>
      ))}
    </nav>
  );
}

function CreateEventForm({
  initiallyOpen,
  disabled,
  onCreate,
}: {
  initiallyOpen: boolean;
  disabled: boolean;
  onCreate(input: CreateEventInput): Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [eventDate, setEventDate] = useState("");
  const [teamPin, setTeamPin] = useState("");

  async function submit(formEvent: FormEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault();
    if (await onCreate({ name, eventDate, teamPin })) {
      setName("");
      setEventDate("");
      setTeamPin("");
    }
  }

  return (
    <details className="admin-create-event" open={initiallyOpen || undefined}>
      <summary>Neues Event erstellen</summary>
      <form onSubmit={(formEvent) => void submit(formEvent)}>
        <label htmlFor="admin-event-name">Eventname</label>
        <input
          id="admin-event-name"
          value={name}
          maxLength={120}
          required
          disabled={disabled}
          onChange={(changeEvent) => setName(changeEvent.target.value)}
        />
        <label htmlFor="admin-event-date">Eventdatum</label>
        <input
          id="admin-event-date"
          type="date"
          value={eventDate}
          required
          disabled={disabled}
          onChange={(changeEvent) => setEventDate(changeEvent.target.value)}
        />
        <label htmlFor="admin-event-pin">Sechsstellige Team-PIN</label>
        <input
          id="admin-event-pin"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          pattern="[0-9]{6}"
          maxLength={6}
          value={teamPin}
          required
          disabled={disabled}
          onChange={(changeEvent) =>
            setTeamPin(changeEvent.target.value.replace(/\D/g, "").slice(0, 6))
          }
        />
        <button className="admin-primary" type="submit" disabled={disabled}>
          Event erstellen
        </button>
      </form>
    </details>
  );
}

function EventDetail({
  detail,
  disabled,
  sponsorsLoading,
  onCreateSponsor,
  onCreateVoucherType,
  onIssueVouchers,
  onCopySponsorLink,
  onDownloadQrPackage,
  onLoadMoreSponsors,
  onChangePin,
  onRevokeSessions,
}: {
  detail: AdminEventDetail;
  disabled: boolean;
  sponsorsLoading: boolean;
  onCreateSponsor(name: string): Promise<boolean>;
  onCreateVoucherType(sponsorId: string, name: string): Promise<boolean>;
  onIssueVouchers(sponsorId: string, voucherTypeId: string, count: number): Promise<boolean>;
  onCopySponsorLink(sponsor: AdminSponsor): Promise<boolean>;
  onDownloadQrPackage(sponsor: AdminSponsor, voucherType: AdminVoucherType): Promise<boolean>;
  onLoadMoreSponsors(): Promise<void>;
  onChangePin(pin: string): Promise<boolean>;
  onRevokeSessions(): Promise<boolean>;
}) {
  return (
    <div className="admin-detail">
      <header className="admin-event-heading">
        <h1>{detail.event.name}</h1>
        <p>
          <CalendarIcon />
          <time dateTime={detail.event.eventDate}>{formatEventDate(detail.event.eventDate)}</time>
        </p>
        <a href={`/team/${encodeURIComponent(detail.event.publicId)}`} target="_blank" rel="noreferrer">
          Team-Anmeldung öffnen
        </a>
      </header>

      <EventSummary summary={detail.summary} />
      <SponsorSection
        sponsors={detail.sponsors}
        sponsorsNextCursor={detail.sponsorsNextCursor}
        sponsorsLoading={sponsorsLoading}
        disabled={disabled}
        onCreateSponsor={onCreateSponsor}
        onCreateVoucherType={onCreateVoucherType}
        onIssueVouchers={onIssueVouchers}
        onCopySponsorLink={onCopySponsorLink}
        onDownloadQrPackage={onDownloadQrPackage}
        onLoadMoreSponsors={onLoadMoreSponsors}
      />
      <TeamSessionsSection
        sessions={detail.teamSessions}
        disabled={disabled}
        onChangePin={onChangePin}
        onRevokeSessions={onRevokeSessions}
      />
    </div>
  );
}

function EventSummary({ summary }: { summary: AdminEventDetail["summary"] }) {
  return (
    <section className="admin-summary" aria-label="Gutschein-Übersicht">
      <div>
        <TicketIcon />
        <strong>{summary.issuedCount}</strong>
        <span>Ausgegeben</span>
      </div>
      <div>
        <CheckIcon />
        <strong>{summary.availableCount}</strong>
        <span>Verfügbar</span>
      </div>
      <div>
        <DrinkIcon />
        <strong>{summary.redeemedCount}</strong>
        <span>Eingelöst</span>
      </div>
    </section>
  );
}

function SponsorSection({
  sponsors,
  sponsorsNextCursor,
  sponsorsLoading,
  disabled,
  onCreateSponsor,
  onCreateVoucherType,
  onIssueVouchers,
  onCopySponsorLink,
  onDownloadQrPackage,
  onLoadMoreSponsors,
}: {
  sponsors: AdminSponsor[];
  sponsorsNextCursor: string | null;
  sponsorsLoading: boolean;
  disabled: boolean;
  onCreateSponsor(name: string): Promise<boolean>;
  onCreateVoucherType(sponsorId: string, name: string): Promise<boolean>;
  onIssueVouchers(sponsorId: string, voucherTypeId: string, count: number): Promise<boolean>;
  onCopySponsorLink(sponsor: AdminSponsor): Promise<boolean>;
  onDownloadQrPackage(sponsor: AdminSponsor, voucherType: AdminVoucherType): Promise<boolean>;
  onLoadMoreSponsors(): Promise<void>;
}) {
  const [name, setName] = useState("");
  const [issuingVoucherKey, setIssuingVoucherKey] = useState<string | null>(null);
  const [downloadingVoucherKey, setDownloadingVoucherKey] = useState<string | null>(null);
  const [creatingTypeSponsorId, setCreatingTypeSponsorId] = useState<string | null>(null);
  const [voucherTypeName, setVoucherTypeName] = useState("");
  const [voucherCount, setVoucherCount] = useState(1);

  async function createSponsor(formEvent: FormEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault();
    if (await onCreateSponsor(name)) {
      setName("");
    }
  }

  async function createVoucherType(
    formEvent: FormEvent<HTMLFormElement>,
    sponsorId: string,
  ): Promise<void> {
    formEvent.preventDefault();
    if (await onCreateVoucherType(sponsorId, voucherTypeName)) {
      setCreatingTypeSponsorId(null);
      setVoucherTypeName("");
    }
  }

  async function issueVouchers(
    formEvent: FormEvent<HTMLFormElement>,
    sponsorId: string,
    voucherTypeId: string,
  ): Promise<void> {
    formEvent.preventDefault();
    if (await onIssueVouchers(sponsorId, voucherTypeId, voucherCount)) {
      setIssuingVoucherKey(null);
      setVoucherCount(1);
    }
  }

  async function downloadQrPackage(
    sponsor: AdminSponsor,
    voucherType: AdminVoucherType,
  ): Promise<void> {
    const key = `${sponsor.id}:${voucherType.id}`;
    setDownloadingVoucherKey(key);
    try {
      await onDownloadQrPackage(sponsor, voucherType);
    } finally {
      setDownloadingVoucherKey(null);
    }
  }

  return (
    <section className="admin-section" aria-labelledby="admin-sponsors-title">
      <div className="admin-section-heading">
        <h2 id="admin-sponsors-title">Sponsoren</h2>
        <form className="admin-inline-create" onSubmit={(formEvent) => void createSponsor(formEvent)}>
          <label htmlFor="admin-sponsor-name">Sponsorname</label>
          <input
            id="admin-sponsor-name"
            value={name}
            maxLength={120}
            required
            disabled={disabled}
            onChange={(changeEvent) => setName(changeEvent.target.value)}
          />
          <button className="admin-primary" type="submit" disabled={disabled}>
            <PlusIcon />
            Sponsor hinzufügen
          </button>
        </form>
      </div>

      {sponsors.length === 0 ? (
        <p className="admin-empty-row">Noch keine Sponsoren angelegt.</p>
      ) : (
        <div className="admin-table-wrap">
          <table aria-label="Sponsoren">
            <thead>
              <tr>
                <th scope="col">Sponsor</th>
                <th scope="col">Ausgegeben</th>
                <th scope="col">Verfügbar</th>
                <th scope="col">Eingelöst</th>
                <th scope="col">Sponsor-Link</th>
                <th scope="col">Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {sponsors.map((sponsor) => {
                const url = sponsorUrl(sponsor.accessId);
                return (
                  <tr key={sponsor.id}>
                    <th
                      id={`admin-sponsor-name-${sponsor.id}`}
                      scope="row"
                      data-label="Sponsor"
                    >
                      {sponsor.name}
                    </th>
                    <td data-label="Ausgegeben">{sponsor.issuedCount}</td>
                    <td className="admin-count-available" data-label="Verfügbar">
                      {sponsor.availableCount}
                    </td>
                    <td className="admin-count-redeemed" data-label="Eingelöst">
                      {sponsor.redeemedCount}
                    </td>
                    <td data-label="Sponsor-Link">
                      <input
                        className="admin-link-field"
                        aria-label={`Sponsor-Link für ${sponsor.name}`}
                        value={url}
                        readOnly
                        onFocus={(focusEvent) => focusEvent.currentTarget.select()}
                      />
                    </td>
                    <td className="admin-sponsor-actions" data-label="Aktionen">
                      <button
                        type="button"
                        aria-label={`Link für ${sponsor.name} kopieren`}
                        disabled={disabled}
                        onClick={() => void onCopySponsorLink(sponsor)}
                      >
                        <LinkIcon />
                        Link kopieren
                      </button>
                      <div
                        className="admin-voucher-types"
                        aria-label={`Gutscheinarten für ${sponsor.name}`}
                      >
                        {sponsor.voucherTypes.length === 0 ? (
                          <p className="admin-empty-row">Noch keine Gutscheinarten angelegt.</p>
                        ) : (
                          sponsor.voucherTypes.map((voucherType) => {
                            const key = `${sponsor.id}:${voucherType.id}`;
                            return (
                              <article className="admin-voucher-type" key={voucherType.id}>
                                <div className="admin-voucher-type-heading">
                                  <h3>{voucherType.name}</h3>
                                  <span>
                                    {voucherType.issuedCount} ausgegeben · {voucherType.availableCount} verfügbar · {voucherType.redeemedCount} eingelöst
                                  </span>
                                </div>
                                <div className="admin-voucher-type-actions">
                                  {voucherType.issuedCount > 0 ? (
                                    <button
                                      type="button"
                                      aria-label={
                                        downloadingVoucherKey === key
                                          ? `QR-Paket wird erstellt (${voucherType.name}, ${voucherType.issuedCount})`
                                          : `QR-Paket herunterladen (${voucherType.name}, ${voucherType.issuedCount})`
                                      }
                                      aria-describedby={`admin-sponsor-name-${sponsor.id}`}
                                      disabled={disabled || downloadingVoucherKey !== null}
                                      onClick={() => void downloadQrPackage(sponsor, voucherType)}
                                    >
                                      <DownloadIcon />
                                      {downloadingVoucherKey === key
                                        ? "QR-Paket wird erstellt …"
                                        : `QR-Paket herunterladen (${voucherType.issuedCount})`}
                                    </button>
                                  ) : null}
                                  {issuingVoucherKey === key ? (
                                    <form
                                      onSubmit={(formEvent) =>
                                        void issueVouchers(formEvent, sponsor.id, voucherType.id)
                                      }
                                    >
                                      <label htmlFor={`voucher-count-${sponsor.id}-${voucherType.id}`}>
                                        Anzahl Gutscheine für {sponsor.name} – {voucherType.name}
                                      </label>
                                      <input
                                        id={`voucher-count-${sponsor.id}-${voucherType.id}`}
                                        type="number"
                                        min={1}
                                        max={500}
                                        value={voucherCount}
                                        required
                                        disabled={disabled}
                                        onChange={(changeEvent) =>
                                          setVoucherCount(Number(changeEvent.target.value))
                                        }
                                      />
                                      <button className="admin-primary" type="submit" disabled={disabled}>
                                        {voucherCount} Gutscheine für {voucherType.name} erstellen
                                      </button>
                                      <button
                                        type="button"
                                        disabled={disabled}
                                        onClick={() => setIssuingVoucherKey(null)}
                                      >
                                        Abbrechen
                                      </button>
                                    </form>
                                  ) : (
                                    <button
                                      className="admin-primary"
                                      type="button"
                                      aria-label={`Gutscheine für ${sponsor.name} – ${voucherType.name} erstellen`}
                                      disabled={disabled}
                                      onClick={() => {
                                        setVoucherCount(1);
                                        setIssuingVoucherKey(key);
                                      }}
                                    >
                                      <TicketIcon />
                                      Gutscheine erstellen
                                    </button>
                                  )}
                                </div>
                              </article>
                            );
                          })
                        )}
                      </div>
                      {creatingTypeSponsorId === sponsor.id ? (
                        <form onSubmit={(formEvent) => void createVoucherType(formEvent, sponsor.id)}>
                          <label htmlFor={`voucher-type-name-${sponsor.id}`}>
                            Neue Gutscheinart für {sponsor.name}
                          </label>
                          <input
                            id={`voucher-type-name-${sponsor.id}`}
                            value={voucherTypeName}
                            maxLength={80}
                            required
                            disabled={disabled}
                            onChange={(changeEvent) => setVoucherTypeName(changeEvent.target.value)}
                          />
                          <button className="admin-primary" type="submit" disabled={disabled}>
                            Gutscheinart anlegen
                          </button>
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => setCreatingTypeSponsorId(null)}
                          >
                            Abbrechen
                          </button>
                        </form>
                      ) : (
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => {
                            setVoucherTypeName("");
                            setCreatingTypeSponsorId(sponsor.id);
                          }}
                        >
                          <PlusIcon />
                          Gutscheinart hinzufügen
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {sponsorsNextCursor ? (
        <div className="admin-load-more">
          <button
            type="button"
            disabled={disabled || sponsorsLoading}
            aria-live="polite"
            onClick={() => void onLoadMoreSponsors()}
          >
            {sponsorsLoading ? "Sponsoren werden geladen …" : "Weitere Sponsoren laden"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function TeamSessionsSection({
  sessions,
  disabled,
  onChangePin,
  onRevokeSessions,
}: {
  sessions: AdminEventDetail["teamSessions"];
  disabled: boolean;
  onChangePin(pin: string): Promise<boolean>;
  onRevokeSessions(): Promise<boolean>;
}) {
  const [editingPin, setEditingPin] = useState(false);
  const [pin, setPin] = useState("");
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  async function submitPin(formEvent: FormEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault();
    if (await onChangePin(pin)) {
      setPin("");
      setEditingPin(false);
    }
  }

  async function revoke(): Promise<void> {
    if (await onRevokeSessions()) {
      setConfirmingRevoke(false);
    }
  }

  return (
    <section className="admin-section admin-team" aria-labelledby="admin-team-title">
      <div className="admin-section-heading admin-team-heading">
        <h2 id="admin-team-title">Team-Sitzungen</h2>
        <div className="admin-team-actions">
          {editingPin ? (
            <form onSubmit={(formEvent) => void submitPin(formEvent)}>
              <label htmlFor="admin-new-pin">Neue sechsstellige Team-PIN</label>
              <input
                id="admin-new-pin"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                pattern="[0-9]{6}"
                maxLength={6}
                value={pin}
                required
                disabled={disabled}
                onChange={(changeEvent) =>
                  setPin(changeEvent.target.value.replace(/\D/g, "").slice(0, 6))
                }
              />
              <button className="admin-primary" type="submit" disabled={disabled}>
                Neue PIN speichern
              </button>
              <button type="button" disabled={disabled} onClick={() => setEditingPin(false)}>
                Abbrechen
              </button>
            </form>
          ) : (
            <button type="button" disabled={disabled} onClick={() => setEditingPin(true)}>
              <KeyIcon />
              PIN ändern
            </button>
          )}
          {confirmingRevoke ? (
            <div className="admin-revoke-confirm" role="group" aria-label="Sitzungswiderruf bestätigen">
              <p>Wirklich alle Team-Sitzungen widerrufen?</p>
              <button
                className="admin-danger"
                type="button"
                disabled={disabled}
                onClick={() => void revoke()}
              >
                Widerruf bestätigen
              </button>
              <button type="button" disabled={disabled} onClick={() => setConfirmingRevoke(false)}>
                Abbrechen
              </button>
            </div>
          ) : (
            <button
              className="admin-danger"
              type="button"
              disabled={disabled}
              onClick={() => setConfirmingRevoke(true)}
            >
              <TrashIcon />
              Alle Sitzungen widerrufen
            </button>
          )}
        </div>
      </div>

      {sessions.length === 0 ? (
        <p className="admin-empty-row">Noch keine Team-Sitzungen vorhanden.</p>
      ) : (
        <div className="admin-table-wrap">
          <table aria-label="Team-Sitzungen">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Zuletzt gesehen</th>
                <th scope="col">Erstellt</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session, index) => (
                <tr key={`${session.createdAt}-${index}`}>
                  <th scope="row" data-label="Name">{session.displayName}</th>
                  <td data-label="Zuletzt gesehen">
                    <time dateTime={session.lastSeenAt}>{formatTimestamp(session.lastSeenAt)}</time>
                  </td>
                  <td data-label="Erstellt">
                    <time dateTime={session.createdAt}>{formatTimestamp(session.createdAt)}</time>
                  </td>
                  <td data-label="Status">{sessionStatusLabel(session.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function sponsorUrl(accessId: string): string {
  return new URL(`/s/${encodeURIComponent(accessId)}`, window.location.origin).toString();
}

function formatEventDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? value : eventDateFormatter.format(parsed);
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : timestampFormatter.format(parsed);
}

function sessionStatusLabel(status: AdminTeamSessionStatus): string {
  switch (status) {
    case "active":
      return "Aktiv";
    case "revoked":
      return "Widerrufen";
    case "expired":
      return "Abgelaufen";
    case "superseded":
      return "Veraltet";
  }
}

type IconProps = { className?: string };

function Icon({ children, className }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function DownloadIcon() {
  return <Icon><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14" /></Icon>;
}
function LogoutIcon() {
  return <Icon><path d="M10 5H5v14h5m4-4 4-3-4-3m4 3H9" /></Icon>;
}
function CalendarIcon() {
  return <Icon><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4m8-4v4M3 10h18" /></Icon>;
}
function TicketIcon() {
  return <Icon><path d="M3 7a2 2 0 0 0 0 4v6h18v-6a2 2 0 0 0 0-4V5H3v2Z" /><path d="M9 8h6m-6 4h6" /></Icon>;
}
function CheckIcon() {
  return <Icon><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></Icon>;
}
function DrinkIcon() {
  return <Icon><path d="M7 4h10l-1 17H8L7 4Zm1 5h8" /></Icon>;
}
function PlusIcon() {
  return <Icon><path d="M12 5v14M5 12h14" /></Icon>;
}
function LinkIcon() {
  return <Icon><path d="m10 13 4-4m-8 8-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m6-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" /></Icon>;
}
function KeyIcon() {
  return <Icon><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9m-4 4 2 2m-5 1 2 2" /></Icon>;
}
function TrashIcon() {
  return <Icon><path d="M4 7h16m-10 4v6m4-6v6M6 7l1 14h10l1-14m-9 0V4h6v3" /></Icon>;
}
