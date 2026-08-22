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
type EventStatus =
  | "draft"
  | "published"
  | "registration_open"
  | "ready"
  | "live"
  | "finished"
  | "cancelled";
type EventVisibility = "public" | "private";
type DisplayMode = "standard" | "competition";
type RegistrationStatus = "registered" | "waiting_approval" | "approved" | "rejected";
type AttendanceStatus = "unknown" | "present" | "dns" | "started";
type ResultStatus = "none" | "finished" | "dnf" | "stopped" | "unknown";

interface UserRow {
  id: number;
  first_name: string | null;
  last_name: string | null;
  nickname: string | null;
  emergency_phone: string | null;
  avatar_url: string | null;
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
  owner_id: number | null;
  display_mode: DisplayMode;
  status: EventStatus;
  visibility: EventVisibility;
  description: string | null;
  location: string | null;
  area: string | null;
  finished_at: Date | null;
  requires_approval: boolean;
  is_paused: boolean;
  show_event_info: boolean;
  show_participants: boolean;
  show_route: boolean;
  show_live_locations: boolean;
  show_history_locations: boolean;
  show_results: boolean;
}

interface ParticipantLastLocationRow {
  event_id: string;
  participant_id: number;
  recorded_at: Date | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  emergency: boolean;
  distance_travelled_km: number | null;
  updated_at: Date;
}

interface EventParticipantRow {
  id: number;
  event_id: string;
  user_id: number | null;
  bib: string | null;
  joined_at: Date;
  left_at: Date | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  category: string | null;
  registration_status: RegistrationStatus;
  attendance_status: AttendanceStatus;
  result_status: ResultStatus;
  finished_at: Date | null;
  finish_position: number | null;
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

interface RouteRow {
  id: number;
  owner_id: number | null;
  source: string | null;
  distance_km: number | null;
  elevation_m: number | null;
  track_points: [number, number][] | null;
  point_count: number | null;
}

interface EventRouteRow {
  id: number;
  event_id: string;
  route_id: number;
  created_at: Date;
}

/**
 * Mirrors OWNER_NAME_SELECT_EXPR / OWNER_NAME_RETURNING_EXPR in event.queries.ts: nickname if
 * non-blank, else trimmed "first last" (either half optional), else null.
 */
function computeOwnerName(ownerId: number | null): string | null {
  if (ownerId === null) return null;
  const user = users.find((u) => u.id === ownerId);
  if (!user) return null;
  const nickname = user.nickname?.trim();
  if (nickname) return nickname;
  const fullName = [user.first_name, user.last_name]
    .filter((part) => part)
    .join(" ")
    .trim();
  return fullName || null;
}

/** Mirrors OWNER_AVATAR_SELECT_EXPR / OWNER_AVATAR_RETURNING_EXPR: the owner's raw avatar_url,
 *  or null when there's no owner (legacy data). */
function computeOwnerAvatar(ownerId: number | null): string | null {
  if (ownerId === null) return null;
  const user = users.find((u) => u.id === ownerId);
  return user?.avatar_url ?? null;
}

function withOwnerName<T extends { owner_id: number | null }>(
  row: T,
): T & { owner_name: string | null; owner_avatar_url: string | null } {
  return {
    ...row,
    owner_name: computeOwnerName(row.owner_id),
    owner_avatar_url: computeOwnerAvatar(row.owner_id),
  };
}

/**
 * Mirrors the COALESCE(nickname, "first last", ep.name) expression in
 * selectParticipantsForEvent (participants.queries.ts): a real account (user_id set) prefers
 * its nickname, else trimmed "first last", else falls through to the raw name column — which
 * is also exactly what happens for a manual/account-less participant (user_id null), since
 * there's no user row to find in that case.
 */
function computeParticipantDisplayName(row: EventParticipantRow): string | null {
  const user = row.user_id !== null ? users.find((u) => u.id === row.user_id) : undefined;
  if (user) {
    const nickname = user.nickname?.trim();
    if (nickname) return nickname;
    const fullName = [user.first_name, user.last_name]
      .filter((part) => part)
      .join(" ")
      .trim();
    if (fullName) return fullName;
  }
  return row.name;
}

function computeParticipantAvatar(row: EventParticipantRow): string | null {
  if (row.user_id === null) return null;
  const user = users.find((u) => u.id === row.user_id);
  return user?.avatar_url ?? null;
}

function withParticipantDisplay(
  row: EventParticipantRow,
): EventParticipantRow & { display_name: string | null; avatar_url: string | null } {
  return {
    ...row,
    display_name: computeParticipantDisplayName(row),
    avatar_url: computeParticipantAvatar(row),
  };
}

const users: UserRow[] = [];
const authIdentities: AuthIdentityRow[] = [];
const sessions: SessionRow[] = [];
const otpChallenges: OtpChallengeRow[] = [];
const events: EventRow[] = [];
const eventParticipants: EventParticipantRow[] = [];
const locationPoints: LocationPointRow[] = [];
const participantLastLocations: ParticipantLastLocationRow[] = [];
const routes: RouteRow[] = [];
const eventRoutes: EventRouteRow[] = [];

const nextId = {
  user: 1,
  identity: 1,
  session: 1,
  otp: 1,
  participant: 1,
  point: 1,
  route: 1,
  eventRoute: 1,
};

export function resetFakeDb() {
  users.length = 0;
  authIdentities.length = 0;
  sessions.length = 0;
  otpChallenges.length = 0;
  events.length = 0;
  eventParticipants.length = 0;
  locationPoints.length = 0;
  participantLastLocations.length = 0;
  routes.length = 0;
  eventRoutes.length = 0;
  nextId.user = 1;
  nextId.identity = 1;
  nextId.session = 1;
  nextId.otp = 1;
  nextId.participant = 1;
  nextId.point = 1;
  nextId.route = 1;
  nextId.eventRoute = 1;
}

/**
 * Test-only helper for seeding an event directly, without going through POST /events — handy
 * for tests that are about something downstream of event creation (joining, location ingest)
 * rather than creation itself.
 */
export function seedEvent(input: {
  id: string;
  code: string;
  name: string;
  type?: EventType;
  requiresBib?: boolean;
  isActive?: boolean;
  ownerId?: number | null;
  status?: EventStatus;
  visibility?: EventVisibility;
}): EventRow {
  const now = new Date();
  const isActive = input.isActive ?? true;
  const row: EventRow = {
    id: input.id,
    code: input.code,
    name: input.name,
    type: input.type ?? "RIDE",
    requires_bib: input.requiresBib ?? false,
    starts_at: null,
    ends_at: null,
    is_active: isActive,
    created_at: now,
    updated_at: now,
    owner_id: input.ownerId ?? null,
    display_mode: "standard",
    status: input.status ?? (isActive ? "published" : "draft"),
    visibility: input.visibility ?? "private",
    description: null,
    location: null,
    area: null,
    finished_at: null,
    requires_approval: false,
    is_paused: false,
    show_event_info: true,
    show_participants: false,
    show_route: true,
    show_live_locations: false,
    show_history_locations: false,
    show_results: true,
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
    const row = requireRow(
      otpChallenges.find((c) => c.id === id),
      "otp_challenges",
      id,
    );
    row.code_hash = codeHash;
    return [row];
  }
  if (sql.startsWith("UPDATE otp_challenges SET attempt_count")) {
    const [id] = p as [number];
    const row = requireRow(
      otpChallenges.find((c) => c.id === id),
      "otp_challenges",
      id,
    );
    row.attempt_count += 1;
    return [row];
  }
  if (sql.startsWith("UPDATE otp_challenges SET consumed_at")) {
    const [id, consumedAt] = p as [number, Date];
    const row = requireRow(
      otpChallenges.find((c) => c.id === id),
      "otp_challenges",
      id,
    );
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
    const [lastLoginAt, avatarUrl, now] = p as [Date | null, string | null, Date];
    const row: UserRow = {
      id: nextId.user++,
      first_name: null,
      last_name: null,
      nickname: null,
      emergency_phone: null,
      avatar_url: avatarUrl,
      role: "RIDER",
      is_active: true,
      created_at: now,
      updated_at: now,
      last_login_at: lastLoginAt,
    };
    users.push(row);
    return [row];
  }
  // Google sign-in refresh: also overwrites avatar_url. Checked before the plain
  // last-login branch below since both statements share the same text prefix.
  if (sql.startsWith("UPDATE users SET last_login_at = $2, avatar_url")) {
    const [id, at, avatarUrl] = p as [number, Date, string | null];
    const row = users.find((u) => u.id === id);
    if (!row) return [];
    row.last_login_at = at;
    row.avatar_url = avatarUrl;
    row.updated_at = at;
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
  if (sql.includes("FROM events e") && sql.includes("WHERE e.code")) {
    const [code] = p as [string];
    return events
      .filter((e) => e.code === code && e.is_active)
      .slice(0, 1)
      .map(withOwnerName);
  }
  if (sql.includes("FROM events e") && sql.includes("WHERE e.id = $1")) {
    const [id] = p as [string];
    return events.filter((e) => e.id === id).map(withOwnerName);
  }
  if (sql.startsWith("SELECT COUNT(*)::text AS count FROM events WHERE owner_id")) {
    const [ownerId, excludeEventId] = p as [number, string];
    const count = events.filter(
      (e) => e.owner_id === ownerId && e.status === "live" && e.id !== excludeEventId,
    ).length;
    return [{ count: String(count) }];
  }
  if (sql.startsWith("SELECT DISTINCT e.*")) {
    const [userId] = p as [number];
    const joinedEventIds = new Set(
      eventParticipants
        .filter((ep) => ep.user_id === userId && ep.left_at === null)
        .map((ep) => ep.event_id),
    );
    return events
      .filter(
        (e) => (e.owner_id === userId || joinedEventIds.has(e.id)) && e.status !== "cancelled",
      )
      .map(withOwnerName);
  }
  if (sql.includes("FROM events e") && sql.includes("WHERE e.visibility")) {
    const [limit, offset] = p as [number, number];
    return events
      .filter((e) => e.visibility === "public" && e.status !== "cancelled" && e.status !== "draft")
      .slice(offset, offset + limit)
      .map(withOwnerName);
  }
  if (sql.startsWith("SELECT code FROM events WHERE code LIKE")) {
    const [pattern] = p as [string];
    const prefix = pattern.replace(/%$/, "");
    return events.filter((e) => e.code.startsWith(prefix)).map((e) => ({ code: e.code }));
  }
  if (sql.startsWith("INSERT INTO events")) {
    const [
      id,
      code,
      name,
      type,
      requiresBib,
      startsAt,
      endsAt,
      ownerId,
      displayMode,
      visibility,
      description,
      location,
      area,
      requiresApproval,
    ] = p as [
      string,
      string,
      string,
      EventType,
      boolean,
      Date | null,
      Date | null,
      number,
      DisplayMode,
      EventVisibility,
      string | null,
      string | null,
      string | null,
      boolean,
    ];
    const now = new Date();
    const row: EventRow = {
      id,
      code,
      name,
      type,
      requires_bib: requiresBib,
      starts_at: startsAt,
      ends_at: endsAt,
      is_active: false,
      created_at: now,
      updated_at: now,
      owner_id: ownerId,
      display_mode: displayMode,
      status: "draft",
      visibility,
      description,
      location,
      area,
      finished_at: null,
      requires_approval: requiresApproval,
      is_paused: false,
      show_event_info: true,
      show_participants: false,
      show_route: true,
      show_live_locations: false,
      show_history_locations: false,
      show_results: true,
    };
    events.push(row);
    return [withOwnerName(row)];
  }
  if (sql.startsWith("UPDATE events SET name = COALESCE")) {
    const [
      id,
      name,
      type,
      requiresBib,
      startsAt,
      endsAt,
      displayMode,
      visibility,
      description,
      location,
      area,
      showEventInfo,
      showParticipants,
      showRoute,
      showLiveLocations,
      showHistoryLocations,
      showResults,
      requiresApproval,
    ] = p as [
      string,
      string | null,
      EventType | null,
      boolean | null,
      Date | null,
      Date | null,
      DisplayMode | null,
      EventVisibility | null,
      string | null,
      string | null,
      string | null,
      boolean | null,
      boolean | null,
      boolean | null,
      boolean | null,
      boolean | null,
      boolean | null,
      boolean | null,
    ];
    const row = requireRow(
      events.find((e) => e.id === id),
      "events",
      id,
    );
    row.name = name ?? row.name;
    row.type = type ?? row.type;
    row.requires_bib = requiresBib ?? row.requires_bib;
    row.starts_at = startsAt ?? row.starts_at;
    row.ends_at = endsAt ?? row.ends_at;
    row.display_mode = displayMode ?? row.display_mode;
    row.visibility = visibility ?? row.visibility;
    row.description = description ?? row.description;
    row.location = location ?? row.location;
    row.area = area ?? row.area;
    row.show_event_info = showEventInfo ?? row.show_event_info;
    row.show_participants = showParticipants ?? row.show_participants;
    row.show_route = showRoute ?? row.show_route;
    row.show_live_locations = showLiveLocations ?? row.show_live_locations;
    row.show_history_locations = showHistoryLocations ?? row.show_history_locations;
    row.show_results = showResults ?? row.show_results;
    row.requires_approval = requiresApproval ?? row.requires_approval;
    row.updated_at = new Date();
    return [withOwnerName(row)];
  }
  if (sql.startsWith("UPDATE events SET is_paused")) {
    const [id, isPaused] = p as [string, boolean];
    const row = requireRow(
      events.find((e) => e.id === id),
      "events",
      id,
    );
    row.is_paused = isPaused;
    row.updated_at = new Date();
    return [withOwnerName(row)];
  }
  if (sql.startsWith("UPDATE events SET status = $2")) {
    const [id, status, isActive, finishedAt] = p as [string, EventStatus, boolean, Date | null];
    const row = requireRow(
      events.find((e) => e.id === id),
      "events",
      id,
    );
    row.status = status;
    row.is_active = isActive;
    row.finished_at = finishedAt;
    row.updated_at = new Date();
    return [withOwnerName(row)];
  }
  if (
    sql.startsWith("INSERT INTO event_participants (event_id, user_id, bib, registration_status)")
  ) {
    const [eventId, userId, bib, initialStatus] = p as [
      string,
      number,
      string | null,
      RegistrationStatus,
    ];
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
      name: null,
      email: null,
      phone: null,
      category: null,
      registration_status: initialStatus,
      attendance_status: "unknown",
      result_status: "none",
      finished_at: null,
      finish_position: null,
    };
    eventParticipants.push(row);
    return [row];
  }
  if (sql.startsWith("INSERT INTO event_participants (event_id, name")) {
    const [eventId, name, email, phone, category, bib] = p as [
      string,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
    ];
    const row: EventParticipantRow = {
      id: nextId.participant++,
      event_id: eventId,
      user_id: null,
      bib,
      joined_at: new Date(),
      left_at: null,
      name,
      email,
      phone,
      category,
      registration_status: "approved",
      attendance_status: "unknown",
      result_status: "none",
      finished_at: null,
      finish_position: null,
    };
    eventParticipants.push(row);
    return [row];
  }
  // More specific "WHERE id = $1 AND event_id" must be checked before the plain "WHERE id"
  // branch below — the latter's prefix is a substring of the former's SQL text, and
  // startsWith dispatch checks in order, so the narrower pattern has to win first.
  if (sql.startsWith("SELECT * FROM event_participants WHERE id = $1 AND event_id")) {
    const [id, eventId] = p as [number, string];
    return eventParticipants.filter((row) => row.id === id && row.event_id === eventId);
  }
  if (sql.startsWith("SELECT * FROM event_participants WHERE id")) {
    const [id, userId] = p as [number, number];
    return eventParticipants.filter((row) => row.id === id && row.user_id === userId);
  }
  // Narrower "... AND left_at IS NULL" variant must be checked before the plain
  // "... AND user_id = $2" branch below, for the same startsWith-prefix reason noted above.
  if (
    sql.startsWith(
      "SELECT * FROM event_participants WHERE event_id = $1 AND user_id = $2 AND left_at IS NULL",
    )
  ) {
    const [eventId, userId] = p as [string, number];
    return eventParticipants.filter(
      (row) => row.event_id === eventId && row.user_id === userId && row.left_at === null,
    );
  }
  if (sql.startsWith("SELECT * FROM event_participants WHERE event_id = $1 AND user_id")) {
    const [eventId, userId] = p as [string, number];
    return eventParticipants.filter((row) => row.event_id === eventId && row.user_id === userId);
  }
  // selectParticipantsForEvent — LEFT JOIN users for display_name/avatar_url (backs both
  // GET /:eventId/participants and GET /:eventId/live's rider names).
  if (sql.startsWith("SELECT ep.*") && sql.includes("FROM event_participants ep")) {
    const [eventId] = p as [string];
    return eventParticipants
      .filter((row) => row.event_id === eventId && row.left_at === null)
      .sort((a, b) => a.joined_at.getTime() - b.joined_at.getTime())
      .map(withParticipantDisplay);
  }
  if (sql.startsWith("SELECT * FROM event_participants WHERE event_id = $1 ORDER BY")) {
    const [eventId] = p as [string];
    return eventParticipants
      .filter((row) => row.event_id === eventId)
      .sort((a, b) => a.joined_at.getTime() - b.joined_at.getTime());
  }
  if (sql.startsWith("UPDATE event_participants SET left_at = NOW()")) {
    const [eventId, userId] = p as [string, number];
    const row = eventParticipants.find(
      (r) => r.event_id === eventId && r.user_id === userId && r.left_at === null,
    );
    if (!row) return [];
    row.left_at = new Date();
    return [row];
  }
  if (sql.startsWith("UPDATE event_participants SET name = COALESCE")) {
    const [id, eventId, name, email, phone, category, bib] = p as [
      number,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
    ];
    const row = eventParticipants.find((r) => r.id === id && r.event_id === eventId);
    if (!row) return [];
    row.name = name ?? row.name;
    row.email = email ?? row.email;
    row.phone = phone ?? row.phone;
    row.category = category ?? row.category;
    row.bib = bib ?? row.bib;
    return [row];
  }
  if (sql.startsWith("UPDATE event_participants SET registration_status")) {
    const [id, eventId, status] = p as [number, string, RegistrationStatus];
    const row = eventParticipants.find((r) => r.id === id && r.event_id === eventId);
    if (!row) return [];
    row.registration_status = status;
    return [row];
  }
  if (sql.startsWith("DELETE FROM event_participants WHERE id")) {
    const [id, eventId] = p as [number, string];
    const idx = eventParticipants.findIndex((r) => r.id === id && r.event_id === eventId);
    if (idx === -1) return [];
    const [removed] = eventParticipants.splice(idx, 1);
    return [removed];
  }

  // ---- participant_last_location --------------------------------------------------------
  if (
    sql.startsWith("SELECT * FROM participant_last_location WHERE event_id = $1 AND participant_id")
  ) {
    const [eventId, participantId] = p as [string, number];
    return participantLastLocations.filter(
      (row) => row.event_id === eventId && row.participant_id === participantId,
    );
  }
  if (sql.startsWith("SELECT * FROM participant_last_location WHERE event_id = $1 AND ($2")) {
    const [eventId, riderIds] = p as [string, number[] | null];
    return participantLastLocations
      .filter(
        (row) =>
          row.event_id === eventId && (riderIds === null || riderIds.includes(row.participant_id)),
      )
      .sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
  }
  if (sql.startsWith("INSERT INTO participant_last_location")) {
    const [eventId, participantId, recordedAt, lat, lng, accuracy, emergency, distanceKm] = p as [
      string,
      number,
      Date,
      number,
      number,
      number | null,
      boolean,
      number,
    ];
    const existing = participantLastLocations.find(
      (row) => row.event_id === eventId && row.participant_id === participantId,
    );
    if (!existing) {
      participantLastLocations.push({
        event_id: eventId,
        participant_id: participantId,
        recorded_at: recordedAt,
        lat,
        lng,
        accuracy,
        emergency,
        distance_travelled_km: distanceKm,
        updated_at: new Date(),
      });
    } else if (
      existing.recorded_at === null ||
      existing.recorded_at.getTime() < recordedAt.getTime()
    ) {
      existing.recorded_at = recordedAt;
      existing.lat = lat;
      existing.lng = lng;
      existing.accuracy = accuracy;
      existing.emergency = emergency;
      existing.distance_travelled_km = distanceKm;
      existing.updated_at = new Date();
    }
    return [];
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

  // ---- routes / event_routes -----------------------------------------------------------
  if (sql.startsWith("INSERT INTO routes")) {
    const [ownerId, distanceKm, elevationM, trackPointsJson, pointCount] = p as [
      number,
      number,
      number | null,
      string,
      number,
    ];
    const row: RouteRow = {
      id: nextId.route++,
      owner_id: ownerId,
      source: "drawn",
      distance_km: distanceKm,
      elevation_m: elevationM,
      // Mirrors what a real jsonb column round-trips back as: the driver parses it for us.
      track_points: JSON.parse(trackPointsJson),
      point_count: pointCount,
    };
    routes.push(row);
    return [
      {
        id: row.id,
        track_points: row.track_points,
        distance_km: row.distance_km,
        elevation_m: row.elevation_m,
      },
    ];
  }
  if (sql.startsWith("DELETE FROM event_routes WHERE event_id")) {
    const [eventId] = p as [string];
    const remaining = eventRoutes.filter((row) => row.event_id !== eventId);
    const removedCount = eventRoutes.length - remaining.length;
    eventRoutes.length = 0;
    eventRoutes.push(...remaining);
    return new Array(removedCount).fill({});
  }
  if (sql.startsWith("INSERT INTO event_routes")) {
    const [eventId, routeId] = p as [string, number];
    const row: EventRouteRow = {
      id: nextId.eventRoute++,
      event_id: eventId,
      route_id: routeId,
      created_at: new Date(),
    };
    eventRoutes.push(row);
    return [row];
  }
  if (sql.includes("FROM event_routes er") && sql.includes("JOIN routes r")) {
    const [eventId] = p as [string];
    const links = eventRoutes
      .filter((row) => row.event_id === eventId)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    if (links.length === 0) return [];
    const route = routes.find((r) => r.id === links[0].route_id);
    if (!route) return [];
    return [
      {
        id: route.id,
        track_points: route.track_points,
        distance_km: route.distance_km,
        elevation_m: route.elevation_m,
      },
    ];
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

export async function closePool(): Promise<void> { }

export const pool = {
  query: async (text: string, params?: readonly unknown[]) => ({
    rows: runStatement(text, params),
  }),
};
