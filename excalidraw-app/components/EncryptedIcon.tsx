import { Tooltip } from "@excalidraw/excalidraw/components/Tooltip";
import { shield } from "@excalidraw/excalidraw/components/icons";
import { useI18n } from "@excalidraw/excalidraw/i18n";

/** hint that live sessions and share links are end-to-end encrypted */
export const EncryptedIcon = () => {
  const { t } = useI18n();

  return (
    <span className="encrypted-icon tooltip" aria-label={t("encrypted.link")}>
      <Tooltip label={t("encrypted.tooltip")} long={true}>
        {shield}
      </Tooltip>
    </span>
  );
};
