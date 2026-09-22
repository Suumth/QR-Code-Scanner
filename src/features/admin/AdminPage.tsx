import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  changeAdminTeamPin,
  createAdminEvent,
  createAdminSponsor,
  createAdminVoucherType,
  issueAdminVouchers,
  loadAdminCsv,
  loadAdminQrExport,
  loadAdminEvent,
  loadAdminEvents,
  loadAdminSponsorPage,
  loginAdmin,
  logoutAdmin,
  revokeAdminTeamSessions,
} from "./api";
import { AdminDashboard } from "./AdminDashboard";
import { AdminApiError, type AdminEvent, type AdminEventDetail, type AdminSponsor, type CreateEventInput } from "./types";
import { createQrPackage, qrPackageFilename } from "./qr-export";

type Notice = { kind: "success" | "error"; message: string };

interface ReadyState {
  status: "ready";
  events: AdminEvent[];
  selectedEventId: string | null;
  detail: AdminEventDetail | null;
  detailLoading: boolean;
  detailLoadFailed: boolean;
  busy: boolean;
  sponsorsLoading: boolean;
  notice?: Notice;
}

type PageState =
  | { status: "loading" }
  | { status: "login"; failure?: "credentials" | "limited" | "network"; submitting?: boolean }
  | { status: "bootstrapError"; afterLogin: boolean }
  | { status: "loggingOut" }
  | { status: "logoutRecoveryError" }
  | ReadyState;

type DashboardLoadResult = { authenticated: false } | { authenticated: true; state: ReadyState };

export function AdminPage() {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [password, setPassword] = useState("");
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const requestController = useRef<AbortController | null>(null);
  const logoutPreferredEventId = useRef<string | null>(null);
  const contextGeneration = useRef(0);
  const copyAttemptGeneration = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    requestController.current = controller;
    let active = true;
    setState({ status: "loading" });

    void loadDashboard(null, controller.signal)
      .then((result) => {
        if (!active) {
          return;
        }
        setState(result.authenticated ? result.state : { status: "login" });
      })
      .catch((error: unknown) => {
        if (active && !isAbortError(error)) {
          setState({ status: "bootstrapError", afterLogin: false });
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [bootstrapAttempt]);

  useEffect(
    () => () => {
      requestController.current?.abort();
    },
    [],
  );

  function startRequest(): AbortController {
    requestController.current?.abort();
    contextGeneration.current += 1;
    const controller = new AbortController();
    requestController.current = controller;
    return controller;
  }

  async function submitLogin(formEvent: FormEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault();
    const controller = startRequest();
    setState({ status: "login", submitting: true });
    let accepted = false;
    try {
      await loginAdmin(password, controller.signal);
      accepted = true;
      setPassword("");
      const result = await loadDashboard(null, controller.signal);
      if (requestController.current !== controller) {
        return;
      }
      if (!result.authenticated) {
        setState({ status: "bootstrapError", afterLogin: true });
        return;
      }
      setState(result.state);
    } catch (error: unknown) {
      if (requestController.current !== controller || isAbortError(error)) {
        return;
      }
      if (accepted) {
        setState({ status: "bootstrapError", afterLogin: true });
      } else if (error instanceof AdminApiError && error.status === 401) {
        setState({ status: "login", failure: "credentials" });
      } else if (error instanceof AdminApiError && error.status === 429) {
        setState({ status: "login", failure: "limited" });
      } else {
        setState({ status: "login", failure: "network" });
      }
    }
  }

  async function selectEvent(eventId: string): Promise<void> {
    if (state.status !== "ready" || state.selectedEventId === eventId || state.busy) {
      return;
    }
    await loadEventDetail(eventId, state);
  }

  async function retrySelectedEvent(): Promise<void> {
    if (
      state.status !== "ready" ||
      !state.selectedEventId ||
      state.detailLoading ||
      state.busy
    ) {
      return;
    }
    await loadEventDetail(state.selectedEventId, state);
  }

  async function loadEventDetail(eventId: string, snapshot: ReadyState): Promise<void> {
    const controller = startRequest();
    setState({
      ...snapshot,
      selectedEventId: eventId,
      detail: null,
      detailLoading: true,
      detailLoadFailed: false,
      sponsorsLoading: false,
      notice: undefined,
    });
    try {
      const detail = await loadAdminEvent(eventId, controller.signal);
      if (requestController.current === controller) {
        setState({
          ...snapshot,
          selectedEventId: eventId,
          detail,
          detailLoading: false,
          detailLoadFailed: false,
          sponsorsLoading: false,
        });
      }
    } catch (error: unknown) {
      if (requestController.current === controller && !isAbortError(error)) {
        failReady(
          {
            ...snapshot,
            selectedEventId: eventId,
            detail: null,
            detailLoading: false,
            detailLoadFailed: true,
            sponsorsLoading: false,
          },
          error,
          "Event konnte nicht geladen werden.",
        );
      }
    }
  }

  async function handleCreateEvent(input: CreateEventInput): Promise<boolean> {
    if (state.status !== "ready" || state.busy || state.sponsorsLoading) {
      return false;
    }
    const snapshot = state;
    const controller = startRequest();
    setState({ ...snapshot, busy: true, notice: undefined });
    try {
      const created = await createAdminEvent(input, controller.signal);
      const result = await loadDashboard(created.id, controller.signal);
      if (requestController.current !== controller) {
        return false;
      }
      if (!result.authenticated) {
        setPassword("");
        setState({ status: "login" });
        return false;
      }
      setState({
        ...result.state,
        notice: { kind: "success", message: "Event wurde erstellt." },
      });
      return true;
    } catch (error: unknown) {
      if (requestController.current === controller && !isAbortError(error)) {
        failReady(snapshot, error, "Event konnte nicht erstellt werden.");
      }
      return false;
    }
  }

  async function handleCreateSponsor(name: string): Promise<boolean> {
    return runDetailMutation(
      (eventId, signal) => createAdminSponsor(eventId, name, signal),
      "Sponsor wurde angelegt.",
      "Sponsor konnte nicht angelegt werden.",
    );
  }

  async function handleCreateVoucherType(sponsorId: string, name: string): Promise<boolean> {
    return runDetailMutation(
      (eventId, signal) => createAdminVoucherType(eventId, sponsorId, name, signal),
      "Gutscheinart wurde angelegt.",
      "Gutscheinart konnte nicht angelegt werden.",
    );
  }

  async function handleIssueVouchers(
    sponsorId: string,
    voucherTypeId: string,
    count: number,
  ): Promise<boolean> {
    return runDetailMutation(
      (eventId, signal) => issueAdminVouchers(eventId, sponsorId, voucherTypeId, count, signal),
      `${count} Gutscheine wurden erstellt.`,
      "Gutscheine konnten nicht erstellt werden.",
    );
  }

  async function handleChangePin(pin: string): Promise<boolean> {
    return runDetailMutation(
      (eventId, signal) => changeAdminTeamPin(eventId, pin, signal),
      "Team-PIN wurde geändert.",
      "Team-PIN konnte nicht geändert werden.",
    );
  }

  async function handleRevokeSessions(): Promise<boolean> {
    return runDetailMutation(
      revokeAdminTeamSessions,
      "Alle Team-Sitzungen wurden widerrufen.",
      "Team-Sitzungen konnten nicht widerrufen werden.",
    );
  }

  async function runDetailMutation(
    mutate: (eventId: string, signal: AbortSignal) => Promise<void>,
    successMessage: string,
    errorMessage: string,
  ): Promise<boolean> {
    if (
      state.status !== "ready" ||
      !state.selectedEventId ||
      state.busy ||
      state.sponsorsLoading
    ) {
      return false;
    }
    const snapshot = state;
    const eventId = state.selectedEventId;
    const controller = startRequest();
    setState({ ...snapshot, busy: true, notice: undefined });
    try {
      await mutate(eventId, controller.signal);
      const detail = await loadAdminEvent(eventId, controller.signal);
      if (requestController.current !== controller) {
        return false;
      }
      setState({
        ...snapshot,
        detail,
        busy: false,
        notice: { kind: "success", message: successMessage },
      });
      return true;
    } catch (error: unknown) {
      if (requestController.current === controller && !isAbortError(error)) {
        failReady(snapshot, error, errorMessage);
      }
      return false;
    }
  }

  async function loadMoreSponsors(): Promise<void> {
    if (
      state.status !== "ready" ||
      state.busy ||
      state.sponsorsLoading ||
      !state.selectedEventId ||
      !state.detail?.sponsorsNextCursor
    ) {
      return;
    }
    const eventId = state.selectedEventId;
    const cursor = state.detail.sponsorsNextCursor;
    const controller = startRequest();
    setState({ ...state, sponsorsLoading: true, notice: undefined });
    try {
      const page = await loadAdminSponsorPage(eventId, cursor, controller.signal);
      if (requestController.current !== controller) {
        return;
      }
      setState((current) => {
        if (
          current.status !== "ready" ||
          current.selectedEventId !== eventId ||
          current.detail?.event.id !== eventId ||
          current.detail.sponsorsNextCursor !== cursor
        ) {
          return current;
        }
        const existingIds = new Set(current.detail.sponsors.map((sponsor) => sponsor.id));
        return {
          ...current,
          sponsorsLoading: false,
          detail: {
            ...current.detail,
            sponsors: [
              ...current.detail.sponsors,
              ...page.sponsors.filter((sponsor) => !existingIds.has(sponsor.id)),
            ],
            sponsorsNextCursor: page.nextCursor,
          },
        };
      });
    } catch (error: unknown) {
      if (requestController.current !== controller || isAbortError(error)) {
        return;
      }
      if (error instanceof AdminApiError && error.status === 401) {
        setPassword("");
        setState({ status: "login" });
        return;
      }
      setState((current) =>
        current.status === "ready" &&
        current.selectedEventId === eventId &&
        current.detail?.sponsorsNextCursor === cursor
          ? {
              ...current,
              sponsorsLoading: false,
              notice: { kind: "error", message: "Sponsoren konnten nicht geladen werden." },
            }
          : current,
      );
    }
  }

  async function copySponsorLink(sponsor: AdminSponsor): Promise<boolean> {
    if (
      state.status !== "ready" ||
      state.busy ||
      !state.selectedEventId ||
      !state.detail?.sponsors.some(
        (currentSponsor) =>
          currentSponsor.id === sponsor.id && currentSponsor.accessId === sponsor.accessId,
      )
    ) {
      return false;
    }
    const eventId = state.selectedEventId;
    const requestGeneration = contextGeneration.current;
    const copyGeneration = ++copyAttemptGeneration.current;
    const url = new URL(`/s/${encodeURIComponent(sponsor.accessId)}`, window.location.origin).toString();
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard is unavailable");
      }
      await navigator.clipboard.writeText(url);
      return applyCopyNotice({ kind: "success", message: "Sponsor-Link wurde kopiert." });
    } catch {
      return applyCopyNotice({
        kind: "error",
        message: "Link konnte nicht kopiert werden. Er bleibt im Feld sichtbar.",
      });
    }

    function applyCopyNotice(notice: Notice): boolean {
      if (
        contextGeneration.current !== requestGeneration ||
        copyAttemptGeneration.current !== copyGeneration
      ) {
        return false;
      }
      setState((current) => {
        if (
          current.status !== "ready" ||
          current.selectedEventId !== eventId ||
          !current.detail?.sponsors.some(
            (currentSponsor) =>
              currentSponsor.id === sponsor.id && currentSponsor.accessId === sponsor.accessId,
          ) ||
          contextGeneration.current !== requestGeneration ||
          copyAttemptGeneration.current !== copyGeneration
        ) {
          return current;
        }
        return { ...current, notice };
      });
      return notice.kind === "success";
    }
  }

  async function downloadCsv(): Promise<void> {
    if (
      state.status !== "ready" ||
      !state.selectedEventId ||
      !state.detail ||
      state.busy ||
      state.sponsorsLoading
    ) {
      return;
    }
    const snapshot = state;
    const controller = startRequest();
    setState({ ...snapshot, busy: true, notice: undefined });
    try {
      const blob = await loadAdminCsv(state.selectedEventId, controller.signal);
      const objectUrl = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = `event-vouchers-${state.detail.event.eventDate}.csv`;
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      if (requestController.current === controller) {
        setState({
          ...snapshot,
          busy: false,
          notice: { kind: "success", message: "CSV wurde heruntergeladen." },
        });
      }
    } catch (error: unknown) {
      if (requestController.current === controller && !isAbortError(error)) {
        failReady(snapshot, error, "CSV konnte nicht exportiert werden.");
      }
    }
  }

  async function downloadQrPackage(
    sponsor: AdminSponsor,
    voucherType: AdminSponsor["voucherTypes"][number],
  ): Promise<boolean> {
    if (
      state.status !== "ready" ||
      !state.selectedEventId ||
      !state.detail ||
      voucherType.issuedCount === 0 ||
      state.busy ||
      state.sponsorsLoading ||
      !state.detail.sponsors.some(
        (currentSponsor) =>
          currentSponsor.id === sponsor.id &&
          currentSponsor.accessId === sponsor.accessId &&
          currentSponsor.voucherTypes.some((currentType) => currentType.id === voucherType.id),
      )
    ) {
      return false;
    }
    const snapshot = state;
    const eventId = state.selectedEventId;
    const controller = startRequest();
    setState({ ...snapshot, busy: true, notice: undefined });
    try {
      const data = await loadAdminQrExport(eventId, sponsor.id, voucherType.id, controller.signal);
      if (data.sponsorName !== sponsor.name || data.voucherTypeName !== voucherType.name) {
        throw new Error("QR export sponsor mismatch");
      }
      const packageBytes = createQrPackage(data, window.location.origin);
      const objectUrl = URL.createObjectURL(
        new Blob(
          [
            packageBytes.buffer.slice(
              packageBytes.byteOffset,
              packageBytes.byteOffset + packageBytes.byteLength,
            ) as ArrayBuffer,
          ],
          { type: "application/zip" },
        ),
      );
      try {
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = qrPackageFilename(data.sponsorName, data.voucherTypeName);
        link.hidden = true;
        document.body.append(link);
        link.click();
        link.remove();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      if (requestController.current !== controller) {
        return false;
      }
      setState({
        ...snapshot,
        busy: false,
        notice: { kind: "success", message: "QR-Paket wurde heruntergeladen." },
      });
      return true;
    } catch (error: unknown) {
      if (requestController.current === controller && !isAbortError(error)) {
        failReady(snapshot, error, "QR-Paket konnte nicht heruntergeladen werden.");
      }
      return false;
    }
  }

  async function logout(): Promise<void> {
    if (state.status !== "ready" || state.busy) {
      return;
    }
    logoutPreferredEventId.current = state.selectedEventId;
    const controller = startRequest();
    setState({ status: "loggingOut" });
    try {
      await logoutAdmin(controller.signal);
      if (requestController.current === controller) {
        setPassword("");
        setState({ status: "login" });
      }
    } catch (error: unknown) {
      if (requestController.current === controller && !isAbortError(error)) {
        await recoverLogoutStatus();
      }
    }
  }

  async function recoverLogoutStatus(): Promise<void> {
    const controller = startRequest();
    setState({ status: "loggingOut" });
    try {
      const result = await loadDashboard(logoutPreferredEventId.current, controller.signal);
      if (requestController.current !== controller) {
        return;
      }
      if (!result.authenticated) {
        setPassword("");
        setState({ status: "login" });
        return;
      }
      setState({
        ...result.state,
        notice: { kind: "error", message: "Abmelden nicht möglich. Bitte Verbindung prüfen." },
      });
    } catch (error: unknown) {
      if (requestController.current === controller && !isAbortError(error)) {
        setState({ status: "logoutRecoveryError" });
      }
    }
  }

  function failReady(snapshot: ReadyState, error: unknown, message: string): void {
    if (error instanceof AdminApiError && error.status === 401) {
      setPassword("");
      setState({ status: "login" });
      return;
    }
    setState({
      ...snapshot,
      busy: false,
      notice: { kind: "error", message },
    });
  }

  if (state.status === "loading") {
    return <AdminStatus message="Admin-Sitzung wird geprüft …" />;
  }

  if (state.status === "bootstrapError") {
    return (
      <AdminStatus
        message={
          state.afterLogin
            ? "Sitzung konnte nicht bestätigt werden."
            : "Admin-Sitzung konnte nicht geprüft werden."
        }
        error
        actionLabel="Erneut prüfen"
        onAction={() => setBootstrapAttempt((attempt) => attempt + 1)}
      />
    );
  }

  if (state.status === "loggingOut") {
    return <AdminStatus message="Abmeldung läuft …" />;
  }

  if (state.status === "logoutRecoveryError") {
    return (
      <AdminStatus
        message="Abmeldung konnte nicht bestätigt werden."
        error
        actionLabel="Status erneut prüfen"
        onAction={() => void recoverLogoutStatus()}
      />
    );
  }

  if (state.status === "login") {
    return (
      <AdminLogin
        password={password}
        failure={state.failure}
        submitting={state.submitting ?? false}
        onPasswordChange={setPassword}
        onSubmit={submitLogin}
      />
    );
  }

  return (
    <AdminDashboard
      events={state.events}
      selectedEventId={state.selectedEventId}
      detail={state.detail}
      detailLoading={state.detailLoading}
      detailLoadFailed={state.detailLoadFailed}
      busy={state.busy}
      sponsorsLoading={state.sponsorsLoading}
      notice={state.notice}
      onSelectEvent={(eventId) => void selectEvent(eventId)}
      onRetryEvent={() => void retrySelectedEvent()}
      onCreateEvent={handleCreateEvent}
      onCreateSponsor={handleCreateSponsor}
      onCreateVoucherType={handleCreateVoucherType}
      onIssueVouchers={handleIssueVouchers}
      onCopySponsorLink={copySponsorLink}
      onDownloadQrPackage={downloadQrPackage}
      onLoadMoreSponsors={loadMoreSponsors}
      onChangePin={handleChangePin}
      onRevokeSessions={handleRevokeSessions}
      onDownloadCsv={downloadCsv}
      onLogout={logout}
    />
  );
}

async function loadDashboard(
  preferredEventId: string | null,
  signal: AbortSignal,
): Promise<DashboardLoadResult> {
  const events = await loadAdminEvents(signal);
  if (events === null) {
    return { authenticated: false };
  }
  const selectedEventId =
    events.find((event) => event.id === preferredEventId)?.id ?? events[0]?.id ?? null;
  const detail = selectedEventId ? await loadAdminEvent(selectedEventId, signal) : null;
  return {
    authenticated: true,
    state: {
      status: "ready",
      events,
      selectedEventId,
      detail,
      detailLoading: false,
      detailLoadFailed: false,
      busy: false,
      sponsorsLoading: false,
    },
  };
}

function AdminLogin({
  password,
  failure,
  submitting,
  onPasswordChange,
  onSubmit,
}: {
  password: string;
  failure?: "credentials" | "limited" | "network";
  submitting: boolean;
  onPasswordChange(value: string): void;
  onSubmit(event: FormEvent<HTMLFormElement>): Promise<void>;
}) {
  return (
    <main className="admin-auth-shell">
      <section className="admin-login" aria-labelledby="admin-login-title">
        <div className="voucher-logo voucher-logo--text" aria-label="Event Voucher">QR</div>
        <h1 id="admin-login-title">Administration</h1>
        <p>Mit dem konfigurierten Admin-Passwort anmelden.</p>
        <form onSubmit={(event) => void onSubmit(event)}>
          <label htmlFor="admin-password">Admin-Passwort</label>
          <input
            id="admin-password"
            type="password"
            autoComplete="current-password"
            maxLength={256}
            value={password}
            required
            disabled={submitting}
            onChange={(event) => onPasswordChange(event.target.value)}
          />
          {failure ? <p className="admin-login-error" role="alert">{loginFailureMessage(failure)}</p> : null}
          <button className="admin-primary" type="submit" disabled={submitting}>
            {submitting ? "Anmeldung wird geprüft …" : "Anmelden"}
          </button>
        </form>
      </section>
    </main>
  );
}

function AdminStatus({
  message,
  error = false,
  actionLabel,
  onAction,
}: {
  message: string;
  error?: boolean;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <main className="admin-auth-shell">
      <section className="admin-status-view">
        <div className="voucher-logo voucher-logo--text" aria-label="Event Voucher">QR</div>
        <p role={error ? "alert" : "status"}>{message}</p>
        {actionLabel && onAction ? (
          <button className="admin-primary" type="button" onClick={onAction}>
            {actionLabel}
          </button>
        ) : null}
      </section>
    </main>
  );
}

function loginFailureMessage(failure: "credentials" | "limited" | "network"): string {
  switch (failure) {
    case "credentials":
      return "Admin-Passwort stimmt nicht.";
    case "limited":
      return "Zu viele Anmeldeversuche. Bitte kurz warten.";
    case "network":
      return "Keine Verbindung. Bitte erneut versuchen.";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
