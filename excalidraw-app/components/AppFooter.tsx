import { Footer } from "@excalidraw/excalidraw/index";
import React from "react";

import { DebugFooter, isVisualDebuggerEnabled } from "./DebugCanvas";
import { EncryptedIcon } from "./EncryptedIcon";

export const AppFooter = React.memo(
  ({
    onChange,
    showEncryptionHint = true,
  }: {
    onChange: () => void;
    /** workspace scenes are encrypted with server-held keys, not end-to-end */
    showEncryptionHint?: boolean;
  }) => {
    return (
      <Footer>
        <div
          style={{
            display: "flex",
            gap: ".5rem",
            alignItems: "center",
          }}
        >
          {isVisualDebuggerEnabled() && <DebugFooter onChange={onChange} />}
          {showEncryptionHint && <EncryptedIcon />}
        </div>
      </Footer>
    );
  },
);
