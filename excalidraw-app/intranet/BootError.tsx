/** full-page message when the app cannot start (server down, no access) */
export const BootError = ({
  title = "Excalidraw ist gerade nicht erreichbar",
  message,
  link,
}: {
  title?: string;
  message: string;
  link?: { href: string; label: string };
}) => (
  <div
    style={{
      fontFamily: "Assistant, system-ui, sans-serif",
      maxWidth: "36rem",
      margin: "15vh auto",
      padding: "0 1rem",
      lineHeight: 1.5,
    }}
  >
    <h1 style={{ fontSize: "1.4rem" }}>{title}</h1>
    <p>{message}</p>
    <p>
      {link ? (
        <a href={link.href}>{link.label}</a>
      ) : (
        <button type="button" onClick={() => window.location.reload()}>
          Erneut versuchen
        </button>
      )}
    </p>
  </div>
);
