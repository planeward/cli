import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  APP_SECRET_PREFIX,
  APP_VIEWER_TOKEN_TTL_SECONDS,
  type AppViewerTokenClaims,
} from "@planeward/sdk/server";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
  type JWK,
} from "jose";

import { ensureStateDir } from "./state-dir";

export const KEYS_FILE_NAME = "keys.json";

const ALG = "RS256";

/** `<stateDir>/keys.json`: the project's signing key and local secrets. */
type KeyFile = {
  version: 1;
  kid: string;
  privateJwk: JWK;
  publicJwk: JWK;
  /** `PLANEWARD_APP_SECRET` for the app (`pwa_local_…`). */
  appSecret: string;
  /** `PLANEWARD_WEBHOOK_SECRET` the emulator signs webhooks with. */
  webhookSecret: string;
};

export type EmulatorKeys = {
  kid: string;
  privateKey: CryptoKey;
  /** Body of `GET /api/auth/jwks`. */
  jwks: { keys: JWK[] };
  appSecret: string;
  webhookSecret: string;
};

function isKeyFile(value: unknown): value is KeyFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<KeyFile>;
  return (
    file.version === 1 &&
    typeof file.kid === "string" &&
    typeof file.appSecret === "string" &&
    file.appSecret.startsWith(APP_SECRET_PREFIX) &&
    typeof file.webhookSecret === "string" &&
    Boolean(file.privateJwk) &&
    Boolean(file.publicJwk)
  );
}

async function createKeyFile(): Promise<KeyFile> {
  const { privateKey, publicKey } = await generateKeyPair(ALG, {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  return {
    version: 1,
    kid,
    privateJwk: await exportJWK(privateKey),
    publicJwk,
    appSecret: `${APP_SECRET_PREFIX}local_${randomBytes(24).toString("base64url")}`,
    webhookSecret: `whsec_local_${randomBytes(24).toString("base64url")}`,
  };
}

/**
 * Reads `<stateDir>/keys.json`, creating it (RS256 key pair plus local app
 * and webhook secrets) on first use. The file is written owner-only.
 * Pass `stateDir: null` for an in-memory key set (tests).
 */
export async function loadOrCreateKeys(
  stateDir: string | null
): Promise<EmulatorKeys> {
  let file: KeyFile | null = null;
  const path = stateDir ? join(stateDir, KEYS_FILE_NAME) : null;

  if (path) {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (isKeyFile(parsed)) file = parsed;
    } catch {
      file = null;
    }
  }

  if (!file) {
    file = await createKeyFile();
    if (stateDir && path) {
      await ensureStateDir(stateDir);
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(tmp, path);
    }
  }

  const privateKey = (await importJWK(file.privateJwk, ALG)) as CryptoKey;
  return {
    kid: file.kid,
    privateKey,
    jwks: {
      keys: [{ ...file.publicJwk, kid: file.kid, alg: ALG, use: "sig" }],
    },
    appSecret: file.appSecret,
    webhookSecret: file.webhookSecret,
  };
}

export type ViewerTokenInput = {
  /** Emulator base URL; the `iss` claim (no trailing slash). */
  issuer: string;
  appId: string;
  workspaceId: string;
  installationId: string;
  view: AppViewerTokenClaims["view"];
  /** The APP channel for `experience`; ignored for `dashboard`. */
  channelId: string;
  viewer: {
    id: string;
    role: AppViewerTokenClaims["role"];
    name: string;
    avatar: string | null;
  };
  nowMs: number;
};

/** Same claims as Planeward `buildAppViewerTokenClaims`: `exp = iat + 300`. */
export function buildViewerTokenClaims(
  input: ViewerTokenInput
): AppViewerTokenClaims {
  const iat = Math.floor(input.nowMs / 1000);
  return {
    iss: input.issuer.replace(/\/+$/, ""),
    aud: input.appId,
    sub: input.viewer.id,
    iat,
    exp: iat + APP_VIEWER_TOKEN_TTL_SECONDS,
    workspaceId: input.workspaceId,
    installationId: input.installationId,
    channelId: input.view === "experience" ? input.channelId : null,
    view: input.view,
    role: input.viewer.role,
    name: input.viewer.name,
    avatar: input.viewer.avatar,
  };
}

/** Signs viewer claims with the project key (RS256, `kid` in the header). */
export async function signViewerToken(
  keys: EmulatorKeys,
  claims: AppViewerTokenClaims
): Promise<{ token: string; expiresAt: number }> {
  const token = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: ALG, kid: keys.kid, typ: "JWT" })
    .sign(keys.privateKey);
  return { token, expiresAt: claims.exp * 1000 };
}
