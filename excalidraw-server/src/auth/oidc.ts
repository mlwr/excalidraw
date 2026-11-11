import * as client from "openid-client";
import { createRemoteJWKSet, jwtVerify } from "jose";

import type { Config } from "../config.js";

const BACKCHANNEL_LOGOUT_EVENT =
  "http://schemas.openid.net/event/backchannel-logout";

export interface LoginRequest {
  url: URL;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface CodeExchangeResult {
  idToken: string | undefined;
  idTokenClaims: Record<string, unknown>;
  accessToken: string;
  userinfo: Record<string, unknown> | null;
}

/**
 * Thin wrapper around openid-client. Discovery runs lazily and is retried on
 * the next request when the identity provider was unreachable, so the server
 * starts even while Keycloak is down.
 */
export class OidcClient {
  private configuration: Promise<client.Configuration> | null = null;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  readonly redirectUri: string;

  constructor(private readonly config: Config) {
    this.redirectUri = new URL(
      "/api/auth/callback",
      config.publicUrl,
    ).toString();
  }

  private getConfiguration(): Promise<client.Configuration> {
    if (!this.configuration) {
      const { oidc } = this.config;
      const clientAuth = oidc.clientSecret
        ? client.ClientSecretPost(oidc.clientSecret)
        : client.None();
      this.configuration = client
        .discovery(
          oidc.issuerUrl,
          oidc.clientId,
          oidc.clientSecret ? { client_secret: oidc.clientSecret } : undefined,
          clientAuth,
          {
            execute: oidc.allowInsecureHttp
              ? [client.allowInsecureRequests]
              : [],
            timeout: 10,
          },
        )
        .catch((error) => {
          this.configuration = null;
          throw error;
        });
    }
    return this.configuration;
  }

  /** resolves once the identity provider answered discovery */
  async ready(): Promise<void> {
    await this.getConfiguration();
  }

  async createLoginRequest(): Promise<LoginRequest> {
    const configuration = await this.getConfiguration();
    const codeVerifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.redirectUri,
      scope: this.config.oidc.scopes,
      state,
      nonce,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: "S256",
    });
    return { url, state, nonce, codeVerifier };
  }

  async exchangeCode(
    currentUrl: URL,
    checks: { state: string; nonce: string; codeVerifier: string },
  ): Promise<CodeExchangeResult> {
    const configuration = await this.getConfiguration();
    const tokens = await client.authorizationCodeGrant(
      configuration,
      currentUrl,
      {
        pkceCodeVerifier: checks.codeVerifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      },
    );
    const idTokenClaims = (tokens.claims() || {}) as Record<string, unknown>;

    let userinfo: Record<string, unknown> | null = null;
    if (configuration.serverMetadata().userinfo_endpoint) {
      try {
        userinfo = (await client.fetchUserInfo(
          configuration,
          tokens.access_token,
          String(idTokenClaims.sub),
        )) as Record<string, unknown>;
      } catch {
        // userinfo is optional; roles and groups may already be in the tokens
        userinfo = null;
      }
    }

    return {
      idToken: tokens.id_token,
      idTokenClaims,
      accessToken: tokens.access_token,
      userinfo,
    };
  }

  /** RP-initiated logout URL, or null if the provider has no such endpoint */
  async buildLogoutUrl(idToken: string | null): Promise<string | null> {
    const configuration = await this.getConfiguration();
    if (!configuration.serverMetadata().end_session_endpoint) {
      return null;
    }
    const parameters: Record<string, string> = {
      post_logout_redirect_uri: this.config.oidc.postLogoutRedirectUrl,
    };
    if (idToken) {
      parameters.id_token_hint = idToken;
    }
    return client.buildEndSessionUrl(configuration, parameters).toString();
  }

  get issuer(): string {
    return this.config.oidc.issuerUrl.toString().replace(/\/$/, "");
  }

  /**
   * Verify an OpenID Connect back-channel logout token (sent by Keycloak when
   * a user logs out elsewhere or an admin ends the session).
   */
  async verifyLogoutToken(
    token: string,
  ): Promise<{ sid: string | null; sub: string | null }> {
    const configuration = await this.getConfiguration();
    const metadata = configuration.serverMetadata();
    if (!metadata.jwks_uri) {
      throw new Error("identity provider publishes no jwks_uri");
    }
    if (!this.jwks) {
      this.jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
    }
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: metadata.issuer,
      audience: this.config.oidc.clientId,
      maxTokenAge: "10m",
    });
    const events = payload.events as Record<string, unknown> | undefined;
    if (
      !events ||
      typeof events !== "object" ||
      !(BACKCHANNEL_LOGOUT_EVENT in events)
    ) {
      throw new Error("not a back-channel logout token");
    }
    if ("nonce" in payload) {
      throw new Error("logout token must not contain a nonce");
    }
    const sid = typeof payload.sid === "string" ? payload.sid : null;
    const sub = typeof payload.sub === "string" ? payload.sub : null;
    if (!sid && !sub) {
      throw new Error("logout token has neither sid nor sub");
    }
    return { sid, sub };
  }
}
