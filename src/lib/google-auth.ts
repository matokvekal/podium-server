import { type LoginTicket, OAuth2Client } from "google-auth-library";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

const client = new OAuth2Client();

export interface GoogleIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

export class InvalidGoogleTokenError extends Error {
  constructor(message = "Invalid Google ID token") {
    super(message);
    this.name = "InvalidGoogleTokenError";
  }
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  if (env.GOOGLE_CLIENT_IDS.length === 0) {
    throw new InvalidGoogleTokenError("Server has no GOOGLE_CLIENT_IDS configured");
  }

  logger.info({ audience: env.GOOGLE_CLIENT_IDS }, "verifying google id token");

  let ticket: LoginTicket;
  try {
    ticket = await client.verifyIdToken({
      idToken,
      audience: env.GOOGLE_CLIENT_IDS,
    });
  } catch (err) {
    logger.warn({ err }, "google id token verification failed");
    throw new InvalidGoogleTokenError();
  }

  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    logger.warn({ payload }, "google id token payload missing subject or email");
    throw new InvalidGoogleTokenError("Google token payload is missing subject or email");
  }

  logger.info({ subject: payload.sub, emailVerified: payload.email_verified }, "google id token verified");

  return {
    subject: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: payload.email_verified ?? false,
    name: payload.name ?? null,
    picture: payload.picture ?? null,
  };
}
