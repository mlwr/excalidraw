/**
 * Intranet fork: spotlight (Z4) in the editor's top right, in live
 * sessions: take it (everyone follows your view), give it up, or see who
 * has it.
 */
import clsx from "clsx";

import { useAtomValue } from "../app-jotai";

import { collabAPIAtom, userToFollowAtom } from "./Collab";
import { spotlightAtom } from "./spotlight";

export const SpotlightButton = ({ canPresent }: { canPresent: boolean }) => {
  const collabAPI = useAtomValue(collabAPIAtom);
  const spotlight = useAtomValue(spotlightAtom);
  const following = useAtomValue(userToFollowAtom);

  if (!collabAPI) {
    return null;
  }

  if (spotlight.presenter) {
    const followingPresenter =
      following?.socketId === spotlight.presenter.socketId;
    return (
      <button
        type="button"
        className={clsx(
          "ws-theme ws-spotlight",
          followingPresenter && "is-active",
        )}
        title={
          followingPresenter
            ? `${spotlight.presenter.username} hat das Spotlight. Klicken, um selbst zu schauen.`
            : `${spotlight.presenter.username} hat das Spotlight. Klicken, um wieder zu folgen.`
        }
        onClick={() =>
          collabAPI.setUserToFollow(
            followingPresenter ? null : spotlight.presenter,
          )
        }
      >
        {followingPresenter ? "Spotlight verlassen" : "Spotlight folgen"}
      </button>
    );
  }

  if (!canPresent) {
    return null;
  }

  return (
    <button
      type="button"
      className={clsx(
        "ws-theme ws-spotlight",
        spotlight.presenting && "is-active",
      )}
      aria-pressed={spotlight.presenting}
      title={
        spotlight.presenting
          ? "Spotlight beenden: die anderen sehen wieder, was sie wollen"
          : "Spotlight: alle in der Sitzung folgen deiner Ansicht"
      }
      onClick={() =>
        spotlight.presenting
          ? collabAPI.stopSpotlight()
          : collabAPI.startSpotlight()
      }
    >
      {spotlight.presenting
        ? `Spotlight an · ${spotlight.followers}`
        : "Spotlight"}
    </button>
  );
};
