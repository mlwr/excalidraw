import { DefaultSidebar, Sidebar } from "@excalidraw/excalidraw";
import {
  LibraryIcon,
  presentationIcon,
} from "@excalidraw/excalidraw/components/icons";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { SLIDES_TAB, SlidesTab } from "../workspace/presentation/SlidesTab";

import { TEAM_LIBRARY_TAB, TeamLibrariesTab } from "../workspace/TeamLibraries";

/**
 * Intranet fork: the upstream sidebar only advertised Excalidraw+ features
 * here. It shows the library (personal, on the server) and, with an
 * account, the team and company libraries.
 */
export const AppSidebar = ({
  excalidrawAPI,
  withTeamLibraries,
  canEditSlides,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  withTeamLibraries: boolean;
  /** reorder slides (not for viewers) */
  canEditSlides: boolean;
}) => {
  return (
    <DefaultSidebar>
      <DefaultSidebar.TabTriggers>
        <Sidebar.TabTrigger
          tab={SLIDES_TAB}
          title="Folien und Präsentation"
          aria-label="Folien und Präsentation"
        >
          <span className="ws-teamlib__trigger">{presentationIcon}</span>
        </Sidebar.TabTrigger>
        {withTeamLibraries && (
          <Sidebar.TabTrigger
            tab={TEAM_LIBRARY_TAB}
            title="Team- und Firmenbibliotheken"
            aria-label="Team- und Firmenbibliotheken"
          >
            <span className="ws-teamlib__trigger">{LibraryIcon}</span>
          </Sidebar.TabTrigger>
        )}
      </DefaultSidebar.TabTriggers>
      <Sidebar.Tab tab={SLIDES_TAB}>
        <SlidesTab excalidrawAPI={excalidrawAPI} canEdit={canEditSlides} />
      </Sidebar.Tab>
      {withTeamLibraries && (
        <Sidebar.Tab tab={TEAM_LIBRARY_TAB}>
          <TeamLibrariesTab excalidrawAPI={excalidrawAPI} />
        </Sidebar.Tab>
      )}
    </DefaultSidebar>
  );
};
