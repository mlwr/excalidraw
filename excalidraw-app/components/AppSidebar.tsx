import { DefaultSidebar, Sidebar } from "@excalidraw/excalidraw";
import { LibraryIcon } from "@excalidraw/excalidraw/components/icons";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { TEAM_LIBRARY_TAB, TeamLibrariesTab } from "../workspace/TeamLibraries";

/**
 * Intranet fork: the upstream sidebar only advertised Excalidraw+ features
 * here. It shows the library (personal, on the server) and, with an
 * account, the team and company libraries.
 */
export const AppSidebar = ({
  excalidrawAPI,
  withTeamLibraries,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  withTeamLibraries: boolean;
}) => {
  return (
    <DefaultSidebar>
      {withTeamLibraries && (
        <DefaultSidebar.TabTriggers>
          <Sidebar.TabTrigger
            tab={TEAM_LIBRARY_TAB}
            title="Team- und Firmenbibliotheken"
            aria-label="Team- und Firmenbibliotheken"
          >
            <span className="ws-teamlib__trigger">{LibraryIcon}</span>
          </Sidebar.TabTrigger>
        </DefaultSidebar.TabTriggers>
      )}
      {withTeamLibraries && (
        <Sidebar.Tab tab={TEAM_LIBRARY_TAB}>
          <TeamLibrariesTab excalidrawAPI={excalidrawAPI} />
        </Sidebar.Tab>
      )}
    </DefaultSidebar>
  );
};
