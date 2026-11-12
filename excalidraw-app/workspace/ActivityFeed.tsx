/**
 * Intranet fork: what happened in a workspace (W8). Shows only events of
 * scenes and collections the current user can see.
 */
import { useCallback, useEffect, useState } from "react";

import { scenePath } from "../intranet/routes";
import { workspaceApi } from "../intranet/workspaceApi";

import { Avatar, Button, Notice, formatRelative } from "./ui";

import type { ActivityEvent } from "../intranet/workspaceApi";
import type { ReactNode } from "react";

const sceneLink = (event: ActivityEvent): ReactNode => {
  const name = event.scene?.name || event.details.name || "Szene";
  return event.scene?.available ? (
    <a href={scenePath(event.scene.id)}>„{name}“</a>
  ) : (
    <span className="ws-feed__gone">„{name}“</span>
  );
};

/** "hat „Plan“ bearbeitet" */
const describe = (event: ActivityEvent): ReactNode => {
  const scene = sceneLink(event);
  const collection = `„${event.details.name || "Collection"}“`;
  switch (event.type) {
    case "scene.created":
      return <>hat {scene} angelegt</>;
    case "scene.edited":
      return <>hat {scene} bearbeitet</>;
    case "scene.renamed":
      return (
        <>
          hat „{event.details.before}“ in {scene} umbenannt
        </>
      );
    case "scene.moved":
      return <>hat {scene} verschoben</>;
    case "scene.deleted":
      return <>hat {scene} in den Papierkorb gelegt</>;
    case "scene.restored":
      return <>hat {scene} aus dem Papierkorb geholt</>;
    case "scene.version_restored":
      return <>hat eine frühere Version von {scene} wiederhergestellt</>;
    case "share.scene_grants":
      return <>hat geändert, wer {scene} sehen darf</>;
    case "share.read_link_created":
      return <>hat einen Nur-Lese-Link für {scene} erstellt</>;
    case "collection.created":
      return <>hat die Collection {collection} angelegt</>;
    case "collection.renamed":
      return (
        <>
          hat die Collection „{event.details.before}“ in {collection} umbenannt
        </>
      );
    case "collection.grants":
      return <>hat den Zugriff auf die Collection {collection} geändert</>;
    case "comment.created":
      return <>hat {scene} kommentiert</>;
    case "comment.replied":
      return <>hat auf einen Kommentar in {scene} geantwortet</>;
    case "comment.resolved":
      return <>hat einen Kommentar in {scene} als erledigt markiert</>;
    default:
      return <>hat etwas an {scene} geändert</>;
  }
};

export const ActivityFeed = ({ workspace }: { workspace: string }) => {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await workspaceApi.activity(workspace);
      setEvents(result.events);
      setNext(result.next);
      setError(null);
    } catch (err: any) {
      setError(err.message);
      setEvents([]);
    }
  }, [workspace]);

  useEffect(() => {
    setEvents(null);
    load();
  }, [load]);

  const loadMore = async () => {
    if (!next) {
      return;
    }
    setLoadingMore(true);
    try {
      const result = await workspaceApi.activity(workspace, next);
      setEvents((current) => [...(current || []), ...result.events]);
      setNext(result.next);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoadingMore(false);
    }
  };

  if (events === null) {
    return <p className="ws-muted">Lade …</p>;
  }
  return (
    <>
      {error && <Notice kind="error">{error}</Notice>}
      {events.length === 0 ? (
        <div className="ws-empty">
          <h2>Noch keine Aktivität</h2>
          <p className="ws-muted">
            Hier erscheint, was in Szenen und Collections passiert, die du sehen
            kannst.
          </p>
        </div>
      ) : (
        <ol className="ws-feed" aria-label="Aktivität">
          {events.map((event) => (
            <li key={event.id} className="ws-feed__item">
              {event.actor ? (
                <Avatar id={event.actor.id} name={event.actor.name} />
              ) : (
                <span className="ws-avatar ws-avatar--system">⚙</span>
              )}
              <div className="ws-feed__text">
                <strong>{event.actor?.name || "Automatisch"}</strong>{" "}
                {describe(event)}
                {event.details.via === "api" && (
                  <span className="ws-tag">über die API</span>
                )}
                <div className="ws-feed__time">
                  <time
                    dateTime={event.at}
                    title={new Date(event.at).toLocaleString("de")}
                  >
                    {formatRelative(event.at)}
                  </time>
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
      {next && (
        <div className="ws-feed__more">
          <Button disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "Lade …" : "Ältere Einträge"}
          </Button>
        </div>
      )}
    </>
  );
};
