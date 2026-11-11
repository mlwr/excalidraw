/** shown when the backend cannot confirm a login (server down, misconfigured) */
export const BootError = ({ message }: { message: string }) => (
  <div
    style={{
      fontFamily: "system-ui, sans-serif",
      maxWidth: "36rem",
      margin: "15vh auto",
      padding: "0 1rem",
      lineHeight: 1.5,
    }}
  >
    <h1 style={{ fontSize: "1.4rem" }}>
      Excalidraw ist gerade nicht erreichbar
    </h1>
    <p>{message}</p>
    <p>
      <button type="button" onClick={() => window.location.reload()}>
        Erneut versuchen
      </button>
    </p>
  </div>
);
