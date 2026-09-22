import { useEffect, useState } from "react";

import { loadPublicTeamEvents, type PublicTeamEvent } from "./publicEventsApi";
import { TeamLoginPage, TeamStatus } from "./TeamLoginPage";

type HomeState =
  | { status: "loading" }
  | { status: "ready"; events: PublicTeamEvent[] }
  | { status: "error" };

export function HomeTeamEntry() {
  const [state, setState] = useState<HomeState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [selectedPublicId, setSelectedPublicId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({ status: "loading" });
    void loadPublicTeamEvents(controller.signal)
      .then((events) => {
        if (!active) {
          return;
        }
        setSelectedPublicId((current) =>
          current && events.some((event) => event.publicId === current)
            ? current
            : (events[0]?.publicId ?? null),
        );
        setState({ status: "ready", events });
      })
      .catch((error: unknown) => {
        if (active && !isAbortError(error)) {
          setState({ status: "error" });
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt]);

  if (state.status === "loading") {
    return <TeamStatus message="Events werden geladen …" />;
  }

  if (state.status === "error") {
    return (
      <TeamStatus
        message="Events konnten nicht geladen werden."
        error
        actionLabel="Erneut laden"
        onAction={() => setAttempt((current) => current + 1)}
      />
    );
  }

  if (state.events.length === 0) {
    return <TeamStatus message="Aktuell ist kein Event verfügbar." />;
  }

  const selectedEvent =
    state.events.find((event) => event.publicId === selectedPublicId) ?? state.events[0];

  return (
    <TeamLoginPage
      key={selectedEvent.publicId}
      eventPublicId={selectedEvent.publicId}
      eventDetails={selectedEvent}
      eventPicker={
        state.events.length > 1 ? (
          <div className="team-event-picker">
            <label htmlFor="team-event">Event auswählen</label>
            <select
              id="team-event"
              name="event"
              value={selectedEvent.publicId}
              onChange={(event) => setSelectedPublicId(event.target.value)}
            >
              {state.events.map((event) => (
                <option key={event.publicId} value={event.publicId}>
                  {event.name} · {event.eventDate}
                </option>
              ))}
            </select>
          </div>
        ) : null
      }
    />
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
