import { DefaultSidebar } from "@excalidraw/excalidraw";

/**
 * Intranet fork: the upstream sidebar only advertised Excalidraw+ comments
 * and presentations here. Both come back as real features in later phases;
 * until then the sidebar shows the library only.
 */
export const AppSidebar = () => {
  return <DefaultSidebar />;
};
