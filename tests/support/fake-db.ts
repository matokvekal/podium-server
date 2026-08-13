// An in-memory stand-in for src/db/pool.ts. It exposes the same module surface
// (query / queryOne / execute / withTransaction) and dispatches on the SQL text the query
// files actually send, so the statements themselves stay under test — a typo'd or renamed
// statement fails loudly here instead of silently passing.
//
// Real business logic (hashing, expiry, attempt counting, rotation, revocation) lives in
// the services and runs for real against this store. Only the database is faked.
//
// Rows are stored snake_case, exactly as PostgreSQL would return them, so the mapping in
// each *.queries.ts file is exercised too.

type Role = "RIDER" | "COMMISSAIRE";
type AuthProviderType = "GOOGLE" | "SMS" | "EMAIL_PASSWORD";
type EventType = "RIDE" | "RACE";

interface UserRow {
  id: number;
  first_name: string | null;
  last_name: string | null;
  nickname: string | null;
  emergency_phone: string | null;
  role: Role;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

interface AuthIdentityRow {
  id: number;
  user_id: number;
  provider: AuthProviderType;
  provider_user_id: string;
  email: string | null;
  phone: string | null;
  password_hash: string | null;
  verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
}

interface SessionRow {
  id: number;
  user_id: number;
  refresh_token_hash: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
  device_info: string | null;
  ip_address: string | null;
}

interface OtpChallengeRow {
  id: number;
  phone: string;
  code_hash: string;
  attempt_count: number;
  max_attempts: number;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  request_ip: string | null;
}

interface EventRow {
  id: string;
  code: string;
  name: string;
  type: EventType;
  requires_bib: boolean;
  starts_at: Date | null;
  ends_at: Date | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface EventParticipantRow {
  id: number;
  event_id: string;
  user_id: number | null;
  bib: string | null;
  joined_at: Date;
  left_at: Date | null;
}

interface LocationPointRow {
  id: number;
  participant_id: number;
  lat: number;
  lng: number;
  accuracy: number | null;
  recorded_at: Date;
  received_at: Date;
  emergency: boolean;
}

const users: UserRow[] = [];
const authIdentities: AuthIdentityRow[] = [];
const sessions: SessionRow[] = [];
const otpChallenges: OtpChallengeRow[] = [];
const events: EventRow[] = [];
const eventParticipants: EventParticipantRow[] = [];
const locationPoints: LocationPointRow[] = [];

const nextId = {
  user: 1,
  identity: 1,
  session: 1,
  otp: 1,
  participant: 1,
  point: 1,
};

export function resetFakeDb() {
  users.length = 0;
  authIdentities.length = 0;
  sessions.length = 0;
  otpChallenges.length = 0;
  events.length = 0;
  eventParticipants.length = 0;
  locationPoints.length = 0;
  nextId.user = 1;
  nextId.identity = 1;
  nextId.session = 1;
  nextId.otp = 1;
  nextId.participant = 1;
  nextId.point = 1;
}

/** Test-only helper: there is no create-event endpoint yet (milestone 2). */
export function seedEvent(input: {
  id: string;
  code: string;
  name: string;
  type?: EventType;
  requiresBib?: boolean;
  isActive?: boolean;
}): EventRow {
  const now = new Date();
  const row: EventRow = {
    id: input.id,
    code: input.code,
    name: input.name,
    type: input.type ?? "RIDE",
    requires_bib: input.requiresBib ?? false,
    starts_at: null,
    ends_at: null,
    is_active: input.isActive ?? true,
    created_at: now,
    updated_at: now,
  };
  events.push(row);
  return row;
}

export function storedLocationPoints(): LocationPointRow[] {
  return locationPoints;
}

/** Test-only helper: deactivating an account has no endpoint (it is an admin action). */
export function setUserActive(userId: number, isActive: boolean): void {
  const row = users.find((u) => u.id === userId);
  if (!row) throw new Error(`fake-db: user ${userId} not found`);
  row.is_active = isActive;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// biome-ignore lint/suspicious/noExplicitAny: a fake result set is untyped by nature
type Row = any;

function runStatement(text: string, params: readonly unknown[] = []): Row[] {
  const sql = normalize(text);
  const p = params as unknown[];

  if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return [];

  // ---- otp_challenges -----------------------------------------------------
  if (sql.startsWith("SELECT COUNT(*)::text AS count FROM otp_challenges")) {
    const [phone, since] = p as [string, Date];
    const count = otpChallenges.filter((c) => c.phone === phone && c.created_at >= since).length;
    return [{ count: String(count) }];
  }
  if (sql.startsWith("SELECT * FROM otp_challenges WHERE phone")) {
    const [phone, since] = p as [string, Date];
    return otpChallenges
      .filter((c) => c.phone === phone && c.created_at >= since)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(0, 1);
  }
  if (sql.startsWith("INSERT INTO otp_challenges")) {
    const [phone, expiresAt, maxAttempts, requestIp] = p as [string, Date, number, string | null];
    const row: OtpChallengeRow = {
      id: nextId.otp++,
      phone,
      code_hash: "",
      attempt_count: 0,
      max_attempts: maxAttempts,
      created_at: new Date(),
      expires_at: expiresAt,
      consumed_at: null,
      request_ip: requestIp,
    };
    otpChallenges.push(row);
    return [row];
  }
  if (sql.startsWith("UPDATE otp_challenges SET code_hash")) {
    const [id, codeHash] = p as [number, string];
    const row = requireRow(otpChallenges.find((c) => c.id === id), "otp_challenges", id);
    row.code_hash = codeHash;
    return [row];
  }
  if (sql.startsWith("UPDATE otp_challenges SET attempt_count")) {
    const [id] = p as [number];
    const row = requireRow(otpChallenges.find((c) => c.id === id), "otp_challenges", id);
    row.attempt_count += 1;
    return [row];
  }
  if (sql.startsWith("UPDATE otp_challenges SET consumed_at")) {
    const [id, consumedAt] = p as [number, Date];
    const row = requireRow(otpChallenges.find((c) => c.id === id), "otp_challenges", id);
    row.consumed_at = consumedAt;
    return [row];
  }
  if (sql.startsWith("SELECT * FROM otp_challenges WHERE id")) {
    const [id] = p as [number];
    return otpChallenges.filter((c) => c.id === id);
  }

  // ---- users --------------------------------------------------------------
  if (sql.startsWith("SELECT * FROM users WHERE id")) {
    const [id] = p as [number];
    return users.filter((u) => u.id === id);
  }
  if (sql.startsWith("INSERT INTO users")) {
    const [lastLoginAt, now] = p as [Date | null, Date];
    const row: UserRow = {
      id: nextId.user++,
      first_name: null,
      last_name: null,
      nickname: null,
      emergency_phone: null,
      role: "RIDER",
      is_active: true,
      created_at: now,
      updated_at: now,
      last_login_at: lastLoginAt,
    };
    users.push(row);
    return [row];
  }
  if (sql.startsWith("UPDATE users SET last_login_at")) {
    const [id, at] = p as [number, Date];
    const row = users.find((u) => u.id === id);
    if (!row) return [];
    row.last_login_at = at;
    row.updated_at = at;
    return [row];
  }
  // ⚠ TEMPORARY: supports the developer sign-in — remove with it (see README.md).
  if (sql.startsWith("UPDATE users SET role")) {
    const [id, role] = p as [number, Role];
    const row = users.find((u) => u.id === id);
    if (!row) return [];
    row.role = role;
    row.updated_at = new Date();
    return [row];
  }
  if (sql.startsWith("UPDATE users SET first_name")) {
    const [id, firstName, lastName, nickname, emergencyPhone] = p as [
      number,
      string | null,
      string | null,
      string | null,
      string | null,
    ];
    const row = users.find((u) => u.id === id);
    if (!row) return [];
    row.first_name = firstName ?? row.first_name;
    row.last_name = lastName ?? row.last_name;
    row.nickname = nickname ?? row.nickname;
    row.emergency_phone = emergencyPhone ?? row.emergency_phone;
    row.updated_at = new Date();
    return [row];
  }

  // ---- auth_identities ----------------------------------------------------
  if (sql.startsWith("SELECT * FROM auth_identities WHERE provider")) {
    const [provider, providerUserId] = p as [AuthProviderType, string];
    return authIdentities.filter(
      (i) => i.provider === provider && i.provider_user_id === providerUserId,
    );
  }
  if (sql.startsWith("INSERT INTO auth_identities")) {
    const [userId, provider, providerUserId, email, phone, now] = p as [
      number,
      AuthProviderType,
      string,
      string | null,
      string | null,
      Date,
    ];
    const row: AuthIdentityRow = {
      id: nextId.identity++,
      user_id: userId,
      provider,
      provider_user_id: providerUserId,
      email,
      phone,
      password_hash: null,
      verified_at: null,
      created_at: now,
      updated_at: now,
      last_used_at: now,
    };
    authIdentities.push(row);
    return [row];
  }
  if (sql.startsWith("UPDATE auth_identities SET last_used_at")) {
    const [provider, providerUserId, at] = p as [AuthProviderType, string, Date];
    const row = authIdentities.find(
      (i) => i.provider === provider && i.provider_user_id === providerUserId,
    );
    if (!row) return [];
    row.last_used_at = at;
    row.updated_at = at;
    return [row];
  }

  // ---- sessions -----------------------------------------------------------
  if (sql.startsWith("INSERT INTO sessions")) {
    const [userId, hash, expiresAt, lastUsedAt, deviceInfo, ipAddress] = p as [
      number,
      string,
      Date,
      Date,
      string | null,
      string | null,
    ];
    const row: SessionRow = {
      id: nextId.session++,
      user_id: userId,
      refresh_token_hash: hash,
      created_at: new Date(),
      expires_at: expiresAt,
      revoked_at: null,
      last_used_at: lastUsedAt,
      device_info: deviceInfo,
      ip_address: ipAddress,
    };
    sessions.push(row);
    return [row];
  }
  if (sql.startsWith("UPDATE sessions SET refresh_token_hash")) {
    const [id, hash, expiresAt, lastUsedAt, deviceInfo, ipAddress] = p as [
      number,
      string,
      Date,
      Date,
      string | null,
      string | null,
    ];
    const row = sessions.find((s) => s.id === id);
    if (!row) return [];
    row.refresh_token_hash = hash;
    row.expires_at = expiresAt;
    row.last_used_at = lastUsedAt;
    row.device_info = deviceInfo;
    row.ip_address = ipAddress;
    return [row];
  }
  if (sql.startsWith("SELECT * FROM sessions WHERE refresh_token_hash")) {
    const [hash] = p as [string];
    return sessions.filter((s) => s.refresh_token_hash === hash);
  }
  if (sql.startsWith("UPDATE sessions SET revoked_at") && sql.includes("WHERE id =")) {
    const [id, at] = p as [number, Date];
    const row = sessions.find((s) => s.id === id && s.revoked_at === null);
    if (!row) return [];
    row.revoked_at = at;
    return [row];
  }
  if (sql.startsWith("UPDATE sessions SET revoked_at") && sql.includes("WHERE user_id =")) {
    const [userId, at] = p as [number, Date];
    const rows = sessions.filter((s) => s.user_id === userId && s.revoked_at === null);
    for (const row of rows) row.revoked_at = at;
    return rows.map((row) => ({ id: row.id }));
  }

  // ---- events -------------------------------------------------------------
  if (sql.startsWith("SELECT * FROM events WHERE code")) {
    const [code] = p as [string];
    return events.filter((e) => e.code === code && e.is_active).slice(0, 1);
  }
  if (sql.startsWith("SELECT code FROM events WHERE code LIKE")) {
    const [pattern] = p as [string];
    const prefix = pattern.replace(/%$/, "");
    return events.filter((e) => e.code.startsWith(prefix)).map((e) => ({ code: e.code }));
  }
  if (sql.startsWith("INSERT INTO event_participants")) {
    const [eventId, userId, bib] = p as [string, number, string | null];
    const existing = eventParticipants.find(
      (row) => row.event_id === eventId && row.user_id === userId,
    );
    if (existing) {
      existing.bib = bib ?? existing.bib;
      existing.left_at = null;
      return [existing];
    }
    const row: EventParticipantRow = {
      id: nextId.participant++,
      event_id: eventId,
      user_id: userId,
      bib,
      joined_at: new Date(),
      left_at: null,
    };
    eventParticipants.push(row);
    return [row];
  }
  if (sql.startsWith("SELECT * FROM event_participants WHERE id")) {
    const [id, userId] = p as [number, number];
    return eventParticipants.filter((row) => row.id === id && row.user_id === userId);
  }

  // ---- location_points ----------------------------------------------------
  if (sql.startsWith("INSERT INTO location_points")) {
    const [participantId, lats, lngs, accuracies, recordedAts, emergencies] = p as [
      number,
      number[],
      number[],
      Array<number | null>,
      Date[],
      boolean[],
    ];
    const inserted = lats.map((lat, index) => {
      const row: LocationPointRow = {
        id: nextId.point++,
        participant_id: participantId,
        lat,
        lng: lngs[index],
        accuracy: accuracies[index] ?? null,
        recorded_at: recordedAts[index],
        received_at: new Date(),
        emergency: emergencies[index],
      };
      locationPoints.push(row);
      return { id: row.id };
    });
    return inserted;
  }

  throw new Error(`fake-db: no handler for statement: ${sql}`);
}

function requireRow<T>(row: T | undefined, table: string, id: unknown): T {
  if (!row) throw new Error(`fake-db: ${table} row ${String(id)} not found`);
  return row;
}

export async function query<T>(text: string, params?: readonly unknown[]): Promise<T[]> {
  return runStatement(text, params) as T[];
}

export async function queryOne<T>(text: string, params?: readonly unknown[]): Promise<T | null> {
  return (runStatement(text, params)[0] ?? null) as T | null;
}

export async function execute(text: string, params?: readonly unknown[]): Promise<number> {
  return runStatement(text, params).length;
}

export interface Transaction {
  query<T>(text: string, params?: readonly unknown[]): Promise<T[]>;
  queryOne<T>(text: string, params?: readonly unknown[]): Promise<T | null>;
}

/** No isolation to fake — a single in-memory store cannot half-apply a callback. */
export async function withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return fn({ query, queryOne });
}

export async function closePool(): Promise<void> {}

export const pool = {
  query: async (text: string, params?: readonly unknown[]) => ({
    rows: runStatement(text, params),
  }),
};
