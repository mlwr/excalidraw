import {
  ExportIcon,
  eyeIcon,
  historyIcon,
  LibraryIcon,
  loginIcon,
} from "@excalidraw/excalidraw/components/icons";
import { MainMenu } from "@excalidraw/excalidraw/index";
import React from "react";

import { isDevEnv } from "@excalidraw/common";

import type { Theme } from "@excalidraw/element/types";

import { LanguageList } from "../app-language/LanguageList";
import { getCurrentUser, logout } from "../intranet/session";
import { appJotaiStore } from "../app-jotai";
import { saveToWorkspaceOpenAtom } from "../workspace/SaveToWorkspaceDialog";
import { versionsOpenAtom } from "../workspace/VersionsDialog";

import { saveDebugState } from "./DebugCanvas";

export const AppMainMenu: React.FC<{
  onCollabDialogOpen: () => any;
  isCollaborating: boolean;
  isCollabEnabled: boolean;
  isWorkspaceEnabled?: boolean;
  isWorkspaceScene?: boolean;
  theme: Theme | "system";
  refresh: () => void;
}> = React.memo((props) => {
  const currentUser = getCurrentUser();
  return (
    <MainMenu>
      {props.isWorkspaceEnabled && (
        <>
          <MainMenu.ItemLink icon={LibraryIcon} href="/">
            Zur Übersicht
          </MainMenu.ItemLink>
          {!props.isWorkspaceScene && (
            <MainMenu.Item
              icon={ExportIcon}
              onSelect={() => appJotaiStore.set(saveToWorkspaceOpenAtom, true)}
            >
              Im Workspace speichern…
            </MainMenu.Item>
          )}
          {props.isWorkspaceScene && (
            <MainMenu.Item
              icon={historyIcon}
              onSelect={() => appJotaiStore.set(versionsOpenAtom, true)}
            >
              Versionsverlauf…
            </MainMenu.Item>
          )}
          <MainMenu.Separator />
        </>
      )}
      {!props.isWorkspaceScene && <MainMenu.DefaultItems.LoadScene />}
      <MainMenu.DefaultItems.SaveToActiveFile />
      <MainMenu.DefaultItems.Export />
      <MainMenu.DefaultItems.SaveAsImage />
      {props.isCollabEnabled && (
        <MainMenu.DefaultItems.LiveCollaborationTrigger
          isCollaborating={props.isCollaborating}
          onSelect={() => props.onCollabDialogOpen()}
        />
      )}
      <MainMenu.DefaultItems.CommandPalette className="highlighted" />
      <MainMenu.DefaultItems.SearchMenu />
      <MainMenu.DefaultItems.Help />
      <MainMenu.DefaultItems.ClearCanvas />
      {currentUser && (
        <>
          <MainMenu.Separator />
          <MainMenu.Item
            icon={loginIcon}
            onSelect={() => logout()}
            title={currentUser.email || currentUser.name}
          >
            Abmelden ({currentUser.name})
          </MainMenu.Item>
        </>
      )}
      {isDevEnv() && (
        <MainMenu.Item
          icon={eyeIcon}
          onSelect={() => {
            if (window.visualDebug) {
              delete window.visualDebug;
              saveDebugState({ enabled: false });
            } else {
              window.visualDebug = { data: [] };
              saveDebugState({ enabled: true });
            }
            props?.refresh();
          }}
        >
          Visual Debug
        </MainMenu.Item>
      )}
      <MainMenu.Separator />
      <MainMenu.DefaultItems.Preferences />
      <MainMenu.DefaultItems.ToggleTheme allowSystemTheme theme={props.theme} />
      <MainMenu.ItemCustom>
        <LanguageList style={{ width: "100%" }} />
      </MainMenu.ItemCustom>
      <MainMenu.DefaultItems.ChangeCanvasBackground />
    </MainMenu>
  );
});
