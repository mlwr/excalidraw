import { useAtom } from "../app-jotai";
import { shareDialogStateAtom } from "../share/ShareDialog";

import { SceneShareContent } from "./SceneShareContent";
import { Dialog } from "./ui";

import type { OpenedScene } from "../intranet/workspaceApi";

/** the editor's share dialog for workspace scenes */
export const SceneShareDialog = ({ scene }: { scene: OpenedScene }) => {
  const [shareState, setShareState] = useAtom(shareDialogStateAtom);
  if (!shareState.isOpen) {
    return null;
  }
  const close = () => setShareState({ isOpen: false });
  return (
    <Dialog title={`„${scene.name}“ teilen`} onClose={close}>
      <SceneShareContent scene={scene} onDone={close} />
    </Dialog>
  );
};
