import type { User } from "../../db/types.js";
import { signAccessToken } from "../../lib/jwt.js";
import { createSession, type SessionContext } from "./session.service.js";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export async function issueTokenPair(user: User, context: SessionContext): Promise<TokenPair> {
  const { session, refreshToken } = await createSession(user.id, context);
  const accessToken = await signAccessToken({
    sub: String(user.id),
    role: user.role,
    sid: String(session.id),
  });
  return { accessToken, refreshToken };
}
