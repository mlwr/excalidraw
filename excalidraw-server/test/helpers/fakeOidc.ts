import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import type { IncomingMessage, Server } from "node:http";

/**
 * Minimal OpenID Connect provider that behaves like Keycloak for the parts
 * the server uses: discovery, authorization code + PKCE, token, userinfo,
 * JWKS, end session. The "logged in user" is whatever the test sets.
 */

export interface FakeUser {
  sub: string;
  name?: string;
  email?: string;
  preferred_username?: string;
  realmRoles?: string[];
  clientRoles?: string[];
  groups?: string[];
}

interface PendingCode {
  user: FakeUser;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  sid: string;
}

export interface FakeOidc {
  issuer: string;
  clientId: string;
  clientSecret: string;
  setUser: (user: FakeUser) => void;
  /** last issued Keycloak session id for a subject */
  sidOf: (sub: string) => string | undefined;
  createLogoutToken: (claims: {
    sid?: string;
    sub?: string;
  }) => Promise<string>;
  close: () => Promise<void>;
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => (data += chunk));
    request.on("end", () => resolve(data));
    request.on("error", reject);
  });

export const startFakeOidc = async (
  clientId = "excalidraw",
  clientSecret = "test-secret",
): Promise<FakeOidc> => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "test-key",
    alg: "RS256",
    use: "sig",
  };

  let currentUser: FakeUser = { sub: "user-1", name: "Erika Mustermann" };
  const codes = new Map<string, PendingCode>();
  const accessTokens = new Map<string, FakeUser>();
  const sids = new Map<string, string>();

  let issuer = "";

  const sign = (payload: Record<string, unknown>, typ?: string) =>
    new SignJWT(payload)
      .setProtectedHeader({
        alg: "RS256",
        kid: "test-key",
        ...(typ ? { typ } : {}),
      })
      .setIssuer(issuer)
      .setIssuedAt()
      .sign(privateKey);

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", issuer);
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/certs`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: [
          "client_secret_post",
          "client_secret_basic",
        ],
        backchannel_logout_supported: true,
        backchannel_logout_session_supported: true,
      });
    }

    if (url.pathname.endsWith("/certs")) {
      return json(200, { keys: [jwk] });
    }

    if (url.pathname.endsWith("/auth")) {
      const params = url.searchParams;
      if (
        params.get("client_id") !== clientId ||
        params.get("code_challenge_method") !== "S256"
      ) {
        return json(400, { error: "invalid_request" });
      }
      const code = randomUUID();
      const sid = randomUUID();
      sids.set(currentUser.sub, sid);
      codes.set(code, {
        user: currentUser,
        nonce: params.get("nonce") || "",
        codeChallenge: params.get("code_challenge") || "",
        redirectUri: params.get("redirect_uri") || "",
        sid,
      });
      const redirect = new URL(params.get("redirect_uri")!);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", params.get("state") || "");
      redirect.searchParams.set("session_state", sid);
      redirect.searchParams.set("iss", issuer);
      response.writeHead(302, { location: redirect.toString() });
      return response.end();
    }

    if (url.pathname.endsWith("/token") && request.method === "POST") {
      const form = new URLSearchParams(await readBody(request));
      const pending = codes.get(form.get("code") || "");
      codes.delete(form.get("code") || "");
      if (
        !pending ||
        form.get("client_id") !== clientId ||
        form.get("client_secret") !== clientSecret ||
        form.get("redirect_uri") !== pending.redirectUri
      ) {
        return json(400, { error: "invalid_grant" });
      }
      const challenge = createHash("sha256")
        .update(form.get("code_verifier") || "")
        .digest("base64url");
      if (challenge !== pending.codeChallenge) {
        return json(400, { error: "invalid_grant", error_description: "PKCE" });
      }
      const { user } = pending;
      const accessToken = await sign({
        sub: user.sub,
        aud: "account",
        azp: clientId,
        exp: Math.floor(Date.now() / 1000) + 300,
        sid: pending.sid,
        realm_access: { roles: user.realmRoles || [] },
        resource_access: { [clientId]: { roles: user.clientRoles || [] } },
      });
      accessTokens.set(accessToken, user);
      const idToken = await sign({
        sub: user.sub,
        aud: clientId,
        azp: clientId,
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce: pending.nonce,
        sid: pending.sid,
        name: user.name,
        email: user.email,
        preferred_username: user.preferred_username,
      });
      return json(200, {
        access_token: accessToken,
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 300,
      });
    }

    if (url.pathname.endsWith("/userinfo")) {
      const token = (request.headers.authorization || "").replace(
        /^Bearer /,
        "",
      );
      const user = accessTokens.get(token);
      if (!user) {
        return json(401, { error: "invalid_token" });
      }
      return json(200, {
        sub: user.sub,
        name: user.name,
        email: user.email,
        preferred_username: user.preferred_username,
        groups: user.groups || [],
      });
    }

    if (url.pathname.endsWith("/logout")) {
      response.writeHead(200, { "content-type": "text/plain" });
      return response.end("logged out");
    }

    json(404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake OIDC server did not start");
  }
  issuer = `http://127.0.0.1:${address.port}/realms/test`;

  return {
    issuer,
    clientId,
    clientSecret,
    setUser: (user) => {
      currentUser = user;
    },
    sidOf: (sub) => sids.get(sub),
    createLogoutToken: ({ sid, sub }) =>
      sign(
        {
          aud: clientId,
          jti: randomUUID(),
          events: { "http://schemas.openid.net/event/backchannel-logout": {} },
          ...(sid ? { sid } : {}),
          ...(sub ? { sub } : {}),
        },
        "logout+jwt",
      ),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
