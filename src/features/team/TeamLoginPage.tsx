import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { loadTeamSession, loginTeam, logoutTeam } from "./api";
import { ScannerPage } from "./ScannerPage";
import { TeamLoginError, type TeamLoginFailure, type TeamSessionSnapshot } from "./types";

interface TeamLoginPageProps {
  eventPublicId: string;
  eventDetails?: { name: string; eventDate: string };
  eventPicker?: ReactNode;
}

type PageState =
  | { status: "loading" }
  | { status: "login"; failure?: TeamLoginFailure; phase?: "login" | "bootstrap" }
  | { status: "bootstrapError"; afterLogin: boolean }
  | { status: "ready"; session: TeamSessionSnapshot; logoutFailed?: boolean }
  | { status: "loggingOut" }
  | { status: "logoutRecoveryError" };

export function TeamLoginPage({
  eventPublicId,
  eventDetails,
  eventPicker,
}: TeamLoginPageProps) {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [displayName, setDisplayName] = useState("");
  const [pin, setPin] = useState("");
  const actionController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({ status: "loading" });
    void loadTeamSession(controller.signal)
      .then((session) => {
        if (active) {
          setState(
            session?.event.publicId === eventPublicId
              ? { status: "ready", session }
              : { status: "login" },
          );
        }
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
  }, [attempt, eventPublicId]);

  useEffect(
    () => () => {
      actionController.current?.abort();
    },
    [],
  );

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    actionController.current?.abort();
    const controller = new AbortController();
    actionController.current = controller;
    setState({ status: "login", phase: "login" });
    let loginAccepted = false;

    try {
      await loginTeam(eventPublicId, { displayName, pin }, controller.signal);
      loginAccepted = true;
      setState({ status: "login", phase: "bootstrap" });
      const session = await loadTeamSession(controller.signal);
      setState(
        session?.event.publicId === eventPublicId
          ? { status: "ready", session }
          : { status: "bootstrapError", afterLogin: true },
      );
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return;
      }
      if (error instanceof TeamLoginError) {
        setState({ status: "login", failure: error.failure });
      } else if (loginAccepted) {
        setState({ status: "bootstrapError", afterLogin: true });
      } else {
        setState({ status: "login", failure: "network" });
      }
    }
  }

  async function verifySessionAfterLogoutFailure(): Promise<void> {
    actionController.current?.abort();
    const controller = new AbortController();
    actionController.current = controller;
    setState({ status: "loggingOut" });

    try {
      const session = await loadTeamSession(controller.signal);
      if (actionController.current !== controller) {
        return;
      }
      if (session?.event.publicId === eventPublicId) {
        setState({ status: "ready", session, logoutFailed: true });
      } else {
        setDisplayName("");
        setPin("");
        setState({ status: "login" });
      }
    } catch (error: unknown) {
      if (actionController.current === controller && !isAbortError(error)) {
        setState({ status: "logoutRecoveryError" });
      }
    } finally {
      if (actionController.current === controller) {
        actionController.current = null;
      }
    }
  }

  async function logout(): Promise<void> {
    actionController.current?.abort();
    const controller = new AbortController();
    actionController.current = controller;
    setState({ status: "loggingOut" });
    try {
      await logoutTeam(controller.signal);
      if (actionController.current !== controller) {
        return;
      }
      setDisplayName("");
      setPin("");
      setState({ status: "login" });
    } catch (error: unknown) {
      if (actionController.current === controller && !isAbortError(error)) {
        await verifySessionAfterLogoutFailure();
      }
    }
  }

  if (state.status === "loading") {
    return <TeamStatus message="Sitzung wird geprüft …" />;
  }

  if (state.status === "bootstrapError") {
    return (
      <TeamStatus
        message={
          state.afterLogin
            ? "Sitzung konnte nicht bestätigt werden."
            : "Sitzung konnte nicht geprüft werden."
        }
        error
        actionLabel="Erneut prüfen"
        onAction={() => setAttempt((current) => current + 1)}
      />
    );
  }

  if (state.status === "loggingOut") {
    return <TeamStatus message="Abmeldung läuft …" />;
  }

  if (state.status === "logoutRecoveryError") {
    return (
      <TeamStatus
        message="Abmeldung konnte nicht bestätigt werden. Der Scanner bleibt gesperrt, bis der Sitzungsstatus geprüft wurde."
        error
        actionLabel="Status erneut prüfen"
        onAction={() => void verifySessionAfterLogoutFailure()}
      />
    );
  }

  if (state.status === "ready") {
    return (
      <ScannerPage
        session={state.session}
        logoutFailed={state.logoutFailed ?? false}
        onLogout={() => void logout()}
        onSessionExpired={() => {
          setPin("");
          setState({ status: "login" });
        }}
      />
    );
  }

  return (
    <main className="team-shell team-shell--login">
      <TeamHeader />
      <section className="team-login" aria-labelledby="team-login-title">
        <div>
          <h1 id="team-login-title">Team anmelden</h1>
          <p>Name und sechsstellige Event-PIN eingeben.</p>
          {eventDetails ? (
            <p className="team-event-context">
              <strong>{eventDetails.name}</strong>
              <time dateTime={eventDetails.eventDate}>{eventDetails.eventDate}</time>
            </p>
          ) : null}
        </div>
        <form onSubmit={(event) => void submit(event)}>
          {eventPicker}
          <label htmlFor="team-display-name">Dein Name</label>
          <input
            id="team-display-name"
            name="displayName"
            type="text"
            autoComplete="name"
            maxLength={80}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            required
            disabled={Boolean(state.phase)}
          />

          <label htmlFor="team-pin">Event-PIN</label>
          <input
            id="team-pin"
            name="pin"
            type="password"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
            required
            disabled={Boolean(state.phase)}
          />

          {state.failure ? (
            <p className="team-form-error" role="alert" aria-live="assertive">
              {loginFailureMessage(state.failure)}
            </p>
          ) : null}

          <button className="team-primary-action" type="submit" disabled={Boolean(state.phase)}>
            {state.phase === "login"
              ? "Anmeldung wird geprüft …"
              : state.phase === "bootstrap"
                ? "Sitzung wird geprüft …"
                : "Anmelden"}
          </button>
        </form>
      </section>
    </main>
  );
}

export function TeamHeader() {
  return (
    <header className="team-header">
      <span className="brand-mark" aria-label="Event Voucher">QR</span>
    </header>
  );
}

export function TeamStatus({
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
    <main className="team-shell team-shell--status">
      <TeamHeader />
      <section className="team-status-view">
        <p role={error ? "alert" : "status"}>{message}</p>
        {actionLabel && onAction ? (
          <button className="team-primary-action" type="button" onClick={onAction}>
            {actionLabel}
          </button>
        ) : null}
      </section>
    </main>
  );
}

function loginFailureMessage(failure: TeamLoginFailure): string {
  switch (failure) {
    case "credentials":
      return "Name oder PIN stimmen nicht.";
    case "invalid":
      return "Bitte Name und sechsstellige PIN prüfen.";
    case "limited":
      return "Zu viele Anmeldeversuche. Bitte kurz warten.";
    case "network":
      return "Keine Verbindung. Bitte erneut versuchen.";
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
