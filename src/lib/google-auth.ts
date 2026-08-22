import { type LoginTicket, OAuth2Client } from "google-auth-library";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

const client = new OAuth2Client();

/**
 * What the verified ID token tells us about the person. Only `subject` and `email` are
 * guaranteed — every profile field below depends on scopes and on what the account
 * actually has filled in, so each one is independently nullable.
 */
export interface GoogleIdentity {
  /** Google's `sub`. Stable forever, unlike email — this is the identity key. */
  subject: string;
  email: string;
  emailVerified: boolean;
<<<<<<< HEAD
  name: string | null;
=======
  /** `given_name` */
  firstName: string | null;
  /** `family_name` */
  lastName: string | null;
  /** `name` — the full display name. Read here, but deliberately not stored: writing it
   *  to `nickname` would satisfy needsProfile() and skip the profile-setup screen. */
  displayName: string | null;
  /** `picture` — https URL of the Google avatar, stored as users.avatar_url. */
>>>>>>> 95543e474c16d9b47227287d3fb04f7947e77377
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
<<<<<<< HEAD
    name: payload.name ?? null,
=======
    firstName: payload.given_name ?? null,
    lastName: payload.family_name ?? null,
    displayName: payload.name ?? null,
>>>>>>> 95543e474c16d9b47227287d3fb04f7947e77377
    picture: payload.picture ?? null,
  };
}
