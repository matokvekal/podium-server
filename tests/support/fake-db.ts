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
  finished_at: Date | null;
  activity_type: string | null;
  level: string | null;
  organizer_group: string | null;
  team_id: number | null;
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
  team: string | null;
  country_code: string | null;
  group_id: number | null;
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
  name: string | null;
  route_type: string | null;
  source: string | null;
  distance_km: number | null;
  elevation_m: number | null;
  track_points: unknown;
  markers: unknown;
  preview_points: unknown;
  point_count: number | null;
  is_public: boolean;
  place_name: string | null;
  start_lat: number | null;
  start_lon: number | null;
  end_lat: number | null;
  end_lon: number | null;
  bbox_min_lat: number | null;
  bbox_min_lon: number | null;
  bbox_max_lat: number | null;
  bbox_max_lon: number | null;
  created_at: Date;
  updated_at: Date;
}

interface EventMemberRow {
  event_id: string;
  user_id: number;
  role: string;
}

interface EntitlementGrantRow {
  id: number;
  user_id: number;
  plan_code: string | null;
  feature: string | null;
  quantity: number | null;
  consumed: number;
  scope_type: string | null;
  scope_id: string | null;
  source: string;
  source_ref: string | null;
  starts_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
}

interface CouponRow {
  code: string;
  plan_code: string | null;
  feature: string | null;
  quantity: number | null;
  grant_days: number | null;
  grant_until: Date | null;
  max_redemptions: number | null;
  redeemed_count: number;
  valid_from: Date;
  valid_until: Date | null;
}

interface CouponRedemptionRow {
  coupon_code: string;
  user_id: number;
  grant_id: number | null;
  redeemed_at: Date;
}

interface EventGroupRow {
  id: number;
  event_id: string;
  name: string;
  starts_at: Date | null;
  route_id: number | null;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

interface TeamRow {
  id: number;
  name: string;
  owner_id: number;
  avatar_url: string | null;
  created_at: Date;
  updated_at: Date;
}

interface TeamMemberRow {
  id: number;
  team_id: number;
  user_id: number | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface UserFollowRow {
  follower_id: number;
  followee_id: number;
  created_at: Date;
}

interface ClientActionRow {
  client_action_id: string;
  user_id: number | null;
  event_id: string | null;
  action_type: string | null;
  created_at: Date;
  response_status: number | null;
  response_body: unknown;
}

interface ParticipantTrackRow {
  id: number;
  event_id: string;
  participant_id: number;
  points: unknown;
  point_count: number | null;
  distance_km: number | null;
  started_at: Date | null;
  ended_at: Date | null;
  had_emergency: boolean;
  created_at: Date;
}

interface EventRouteRow {
  id: number;
  event_id: string;
  route_id: number;
  created_at: Date;
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
const participantTracks: ParticipantTrackRow[] = [];
const clientActions: ClientActionRow[] = [];
const eventGroups: EventGroupRow[] = [];
const teams: TeamRow[] = [];
const teamMembers: TeamMemberRow[] = [];
const userFollows: UserFollowRow[] = [];
const eventMembers: EventMemberRow[] = [];
const entitlementGrants: EntitlementGrantRow[] = [];
const coupons: CouponRow[] = [];
const couponRedemptions: CouponRedemptionRow[] = [];

const nextId = {
  user: 1,
  identity: 1,
  session: 1,
  otp: 1,
  participant: 1,
  point: 1,
  route: 1,
  eventRoute: 1,
  track: 1,
  group: 1,
  team: 1,
  teamMember: 1,
  grant: 1,
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
  participantTracks.length = 0;
  clientActions.length = 0;
  eventGroups.length = 0;
  teams.length = 0;
  teamMembers.length = 0;
  userFollows.length = 0;
  eventMembers.length = 0;
  entitlementGrants.length = 0;
  coupons.length = 0;
  couponRedemptions.length = 0;
  nextId.grant = 1;
  nextId.group = 1;
  nextId.team = 1;
  nextId.teamMember = 1;
  nextId.track = 1;
  nextId.route = 1;
  nextId.eventRoute = 1;
  nextId.user = 1;
  nextId.identity = 1;
  nextId.session = 1;
  nextId.otp = 1;
  nextId.participant = 1;
  nextId.point = 1;
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
    finished_at: null,
    activity_type: null,
    level: null,
    organizer_group: null,
    team_id: null,
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

/**
 * Test-only: put a user on a plan or hand them a feature credit, the same way a subscription,
 * a coupon or a purchase would. Mirrors entitlement_grants exactly.
 */
export function seedGrant(input: {
  userId: number;
  planCode?: string;
  feature?: string;
  quantity?: number;
  source?: string;
  expiresAt?: Date | null;
}): number {
  const row: EntitlementGrantRow = {
    id: nextId.grant++,
    user_id: input.userId,
    plan_code: input.planCode ?? null,
    feature: input.feature ?? null,
    quantity: input.quantity ?? null,
    consumed: 0,
    scope_type: null,
    scope_id: null,
    source: input.source ?? "manual",
    source_ref: null,
    starts_at: new Date(Date.now() - 1000),
    expires_at: input.expiresAt ?? null,
    revoked_at: null,
  };
  entitlementGrants.push(row);
  return row.id;
}

export function seedCoupon(input: {
  code: string;
  planCode?: string;
  feature?: string;
  quantity?: number;
  grantDays?: number;
  maxRedemptions?: number;
  validUntil?: Date | null;
}): void {
  coupons.push({
    code: input.code.toUpperCase(),
    plan_code: input.planCode ?? null,
    feature: input.feature ?? null,
    quantity: input.quantity ?? null,
    grant_days: input.grantDays ?? null,
    grant_until: null,
    max_redemptions: input.maxRedemptions ?? null,
    redeemed_count: 0,
    valid_from: new Date(Date.now() - 1000),
    valid_until: input.validUntil ?? null,
  });
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

/**
 * The JOIN in PARTICIPANT_DISPLAY_COLUMNS (src/modules/events/event.queries.ts), by hand.
 * Any fake branch standing in for a query that joins `users` must return rows through this,
 * or the mapping under test silently falls back to the raw (usually NULL) name column.
 */
function withUserDisplay(row: EventParticipantRow): Row {
  const user = row.user_id === null ? undefined : users.find((u) => u.id === row.user_id);
  const fullName = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
  return {
    ...row,
    display_name: row.name ?? (fullName || null) ?? user?.nickname ?? null,
    avatar_url: user?.avatar_url ?? null,
  };
}

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
    // Sign-up carries whatever the provider already knew (Google's given_name /
    // family_name / picture); nickname is always NULL so profile setup still runs.
    const [firstName, lastName, avatarUrl, lastLoginAt, now] = p as [
      string | null,
      string | null,
      string | null,
      Date | null,
      Date,
    ];
    const row: UserRow = {
      id: nextId.user++,
      first_name: firstName,
      last_name: lastName,
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
  if (sql.startsWith("SELECT * FROM events WHERE id")) {
    const [id] = p as [string];
    return events.filter((e) => e.id === id);
  }
  if (sql.startsWith("SELECT * FROM events WHERE owner_id")) {
    const [ownerId] = p as [number];
    return events.filter((e) => e.owner_id === ownerId && e.status === "live").slice(0, 1);
  }
  // More specific first — "events by people I follow" shares this prefix with "my events",
  // and startsWith dispatch takes whichever is registered earlier.
  if (sql.startsWith("SELECT DISTINCT e.* FROM events e LEFT JOIN user_follows")) {
    const [userId] = p as [number];
    const followed = new Set(
      userFollows.filter((f) => f.follower_id === userId).map((f) => f.followee_id),
    );
    const myTeams = new Set(
      teamMembers
        .filter((m) => m.user_id === userId && m.status === "approved")
        .map((m) => m.team_id),
    );
    return events
      .filter(
        (e) =>
          e.visibility === "public" &&
          ["published", "registration_open", "ready", "live"].includes(e.status) &&
          e.owner_id !== userId &&
          ((e.owner_id !== null && followed.has(e.owner_id)) ||
            (e.team_id !== null && myTeams.has(e.team_id))),
      )
      .sort(
        (a, b) =>
          (a.starts_at?.getTime() ?? Number.POSITIVE_INFINITY) -
          (b.starts_at?.getTime() ?? Number.POSITIVE_INFINITY),
      );
  }
  if (sql.startsWith("SELECT DISTINCT e.* FROM events e")) {
    const [userId] = p as [number];
    const joinedEventIds = new Set(
      eventParticipants
        .filter((ep) => ep.user_id === userId && ep.registration_status !== "rejected")
        .map((ep) => ep.event_id),
    );
    return events.filter(
      (e) => (e.owner_id === userId || joinedEventIds.has(e.id)) && e.status !== "cancelled",
    );
  }
  // The public browser: one predicate serves the page and its count, exactly as the real
  // query does.
  function matchesPublicEvent(e: EventRow, params: unknown[]): boolean {
    const [q, type, activityType, level, bucket] = params as [
      string | null,
      EventType | null,
      string | null,
      string | null,
      string | null,
    ];
    if (e.visibility !== "public") return false;
    if (e.status === "cancelled" || e.status === "draft") return false;
    if (q !== null) {
      const hay = `${e.name} ${e.location ?? ""}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    if (type !== null && e.type !== type) return false;
    if (activityType !== null && e.activity_type !== activityType) return false;
    if (level !== null && e.level !== level) return false;
    if (bucket !== null) {
      const now = Date.now();
      const ended = e.ends_at !== null && e.ends_at.getTime() < now;
      if (bucket === "live" && e.status !== "live") return false;
      if (bucket === "upcoming") {
        const upcoming = ["published", "registration_open", "ready"].includes(e.status);
        if (!upcoming || ended) return false;
      }
      // "finished" also catches a ride whose end time passed while its status never moved.
      if (bucket === "finished" && !(e.status === "finished" || ended)) return false;
    }
    return true;
  }

  // More specific first: the plan-limit count is owner-scoped and shares the same prefix as
  // the public-browse count below.
  if (sql.startsWith("SELECT COUNT(*)::text AS count FROM events WHERE owner_id")) {
    const [ownerId, since] = p as [number, Date];
    return [
      {
        count: String(
          events.filter((e) => e.owner_id === ownerId && e.created_at >= since).length,
        ),
      },
    ];
  }
  if (sql.startsWith("SELECT COUNT(*)::text AS count FROM events")) {
    return [{ count: String(events.filter((e) => matchesPublicEvent(e, p)).length) }];
  }
  if (sql.startsWith("SELECT * FROM events WHERE visibility")) {
    const limit = p[5] as number;
    const offset = p[6] as number;
    const sorted = events.filter((e) => matchesPublicEvent(e, p));
    if (sql.includes("ORDER BY created_at DESC")) {
      sorted.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    } else if (sql.includes("ORDER BY starts_at DESC")) {
      sorted.sort((a, b) => (b.starts_at?.getTime() ?? -Infinity) - (a.starts_at?.getTime() ?? -Infinity));
    } else {
      sorted.sort((a, b) => (a.starts_at?.getTime() ?? Infinity) - (b.starts_at?.getTime() ?? Infinity));
    }
    return sorted.slice(offset, offset + limit);
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
      requiresApproval,
      showEventInfo,
      showParticipants,
      showRoute,
      showLiveLocations,
      showHistoryLocations,
      showResults,
      activityType,
      level,
      organizerGroup,
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
      boolean,
      boolean | null,
      boolean | null,
      boolean | null,
      boolean | null,
      boolean | null,
      boolean | null,
      string | null,
      string | null,
      string | null,
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
      finished_at: null,
      activity_type: activityType,
      level,
      organizer_group: organizerGroup,
      team_id: null,
      requires_approval: requiresApproval,
      is_paused: false,
      // The COALESCE(..., <default>) in insertEvent — null means "leave the column default".
      show_event_info: showEventInfo ?? true,
      show_participants: showParticipants ?? false,
      show_route: showRoute ?? true,
      show_live_locations: showLiveLocations ?? false,
      show_history_locations: showHistoryLocations ?? false,
      show_results: showResults ?? true,
    };
    events.push(row);
    return [row];
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
      showEventInfo,
      showParticipants,
      showRoute,
      showLiveLocations,
      showHistoryLocations,
      showResults,
      requiresApproval,
      activityType,
      level,
      organizerGroup,
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
      boolean | null,
      boolean | null,
      boolean | null,
      boolean | null,
      boolean | null,
      boolean | null,
      boolean | null,
      string | null,
      string | null,
      string | null,
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
    row.show_event_info = showEventInfo ?? row.show_event_info;
    row.show_participants = showParticipants ?? row.show_participants;
    row.show_route = showRoute ?? row.show_route;
    row.show_live_locations = showLiveLocations ?? row.show_live_locations;
    row.show_history_locations = showHistoryLocations ?? row.show_history_locations;
    row.show_results = showResults ?? row.show_results;
    row.requires_approval = requiresApproval ?? row.requires_approval;
    row.activity_type = activityType ?? row.activity_type;
    row.level = level ?? row.level;
    row.organizer_group = organizerGroup ?? row.organizer_group;
    row.updated_at = new Date();
    return [row];
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
    return [row];
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
    return [row];
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
      team: null,
      country_code: null,
      group_id: null,
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
    const [eventId, name, email, phone, category, bib, team, countryCode] = p as [
      string,
      string,
      string | null,
      string | null,
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
      team,
      country_code: countryCode,
      group_id: null,
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
  if (sql.startsWith("SELECT ep.*,") && sql.includes("WHERE ep.id = $1 AND ep.event_id = $2")) {
    const [id, eventId] = p as [number, string];
    return eventParticipants
      .filter((row) => row.id === id && row.event_id === eventId)
      .map(withUserDisplay);
  }
  if (sql.startsWith("SELECT * FROM event_participants WHERE id")) {
    const [id, userId] = p as [number, number];
    return eventParticipants.filter((row) => row.id === id && row.user_id === userId);
  }
  if (sql.startsWith("SELECT * FROM event_participants WHERE event_id = $1 AND user_id")) {
    const [eventId, userId] = p as [string, number];
    return eventParticipants.filter((row) => row.event_id === eventId && row.user_id === userId);
  }
  if (sql.startsWith("SELECT ep.*,") && sql.includes("WHERE ep.event_id = $1")) {
    const [eventId] = p as [string];
    return eventParticipants
      .filter((row) => row.event_id === eventId)
      .sort((a, b) => a.joined_at.getTime() - b.joined_at.getTime())
      .map(withUserDisplay);
  }
  if (sql.startsWith("WITH updated AS ( UPDATE event_participants SET name = COALESCE")) {
    const [id, eventId, name, email, phone, category, bib, team, countryCode] = p as [
      number,
      string,
      string | null,
      string | null,
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
    row.team = team ?? row.team;
    row.country_code = countryCode ?? row.country_code;
    return [withUserDisplay(row)];
  }
  if (
    sql.startsWith("WITH updated AS ( UPDATE event_participants SET registration_status")
  ) {
    const [id, eventId, status] = p as [number, string, RegistrationStatus];
    const row = eventParticipants.find((r) => r.id === id && r.event_id === eventId);
    if (!row) return [];
    row.registration_status = status;
    return [withUserDisplay(row)];
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

  // ---- routes ---------------------------------------------------------------------------
  //
  // The real queries never select track_points on a list. These branches copy that: only the
  // by-id branch returns it, so a list query that started leaking full geometry would fail a
  // test here rather than quietly ship.

  function routeWithOwner(row: RouteRow, withGeometry: boolean): Row {
    const user = row.owner_id === null ? undefined : users.find((u) => u.id === row.owner_id);
    const ownerName = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
    const { track_points, ...summary } = row;
    return {
      ...summary,
      ...(withGeometry ? { track_points } : {}),
      owner_name: ownerName || null,
    };
  }

  if (sql.startsWith("INSERT INTO routes")) {
    const [
      ownerId,
      name,
      routeType,
      source,
      distanceKm,
      elevationM,
      trackPoints,
      markers,
      previewPoints,
      pointCount,
      isPublic,
      placeName,
      startLat,
      startLon,
      endLat,
      endLon,
      bboxMinLat,
      bboxMinLon,
      bboxMaxLat,
      bboxMaxLon,
    ] = p as [
      number,
      string | null,
      string | null,
      string,
      number | null,
      number | null,
      string,
      string | null,
      string,
      number,
      boolean,
      string | null,
      number | null,
      number | null,
      number | null,
      number | null,
      number | null,
      number | null,
      number | null,
      number | null,
    ];
    const now = new Date();
    const row: RouteRow = {
      id: nextId.route++,
      owner_id: ownerId,
      name,
      route_type: routeType,
      source,
      distance_km: distanceKm,
      elevation_m: elevationM,
      // The real column is jsonb and the query casts a JSON string into it; pg gives the
      // parsed value back on read, so parse here too.
      track_points: JSON.parse(trackPoints),
      markers: markers === null ? null : JSON.parse(markers),
      preview_points: JSON.parse(previewPoints),
      point_count: pointCount,
      is_public: isPublic,
      place_name: placeName,
      start_lat: startLat,
      start_lon: startLon,
      end_lat: endLat,
      end_lon: endLon,
      bbox_min_lat: bboxMinLat,
      bbox_min_lon: bboxMinLon,
      bbox_max_lat: bboxMaxLat,
      bbox_max_lon: bboxMaxLon,
      created_at: now,
      updated_at: now,
    };
    routes.push(row);
    return [row];
  }
  if (sql.startsWith("SELECT r.*,")) {
    const [routeId] = p as [number];
    return routes.filter((r) => r.id === routeId).map((r) => routeWithOwner(r, true));
  }
  if (sql.startsWith("SELECT r.id, r.owner_id") && sql.includes("WHERE r.owner_id = $1")) {
    const [ownerId] = p as [number];
    return routes
      .filter((r) => r.owner_id === ownerId)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .map((r) => routeWithOwner(r, false));
  }

  // The public browser: the same filter predicate serves the page and its count, so it is
  // written once here too.
  function matchesPublicFilters(r: RouteRow, params: unknown[]): boolean {
    const [place, minDistance, maxDistance, minElevation, maxElevation, type] = params as [
      string | null,
      number | null,
      number | null,
      number | null,
      number | null,
      string | null,
    ];
    if (!r.is_public) return false;
    if (place !== null) {
      const needle = place.toLowerCase();
      const hay = `${r.place_name ?? ""} ${r.name ?? ""}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    if (minDistance !== null && !(r.distance_km !== null && r.distance_km >= minDistance))
      return false;
    if (maxDistance !== null && !(r.distance_km !== null && r.distance_km <= maxDistance))
      return false;
    // A NULL elevation never satisfies an elevation filter — "unknown" is not "0".
    if (minElevation !== null && !(r.elevation_m !== null && r.elevation_m >= minElevation))
      return false;
    if (maxElevation !== null && !(r.elevation_m !== null && r.elevation_m <= maxElevation))
      return false;
    if (type !== null && r.route_type !== type) return false;
    return true;
  }

  if (sql.startsWith("SELECT COUNT(*)::text AS count FROM routes r")) {
    return [{ count: String(routes.filter((r) => matchesPublicFilters(r, p)).length) }];
  }
  if (sql.startsWith("SELECT r.id, r.owner_id") && sql.includes("r.is_public = TRUE")) {
    const limit = p[6] as number;
    const offset = p[7] as number;
    return routes
      .filter((r) => matchesPublicFilters(r, p))
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .slice(offset, offset + limit)
      .map((r) => routeWithOwner(r, false));
  }
  if (sql.startsWith("UPDATE routes SET name = COALESCE")) {
    const [routeId, name, routeType, placeName, isPublic] = p as [
      number,
      string | null,
      string | null,
      string | null,
      boolean | null,
    ];
    const row = routes.find((r) => r.id === routeId);
    if (!row) return [];
    row.name = name ?? row.name;
    row.route_type = routeType ?? row.route_type;
    row.place_name = placeName ?? row.place_name;
    row.is_public = isPublic ?? row.is_public;
    row.updated_at = new Date();
    return [row];
  }
  if (sql.startsWith("DELETE FROM routes WHERE id")) {
    const [routeId] = p as [number];
    const idx = routes.findIndex((r) => r.id === routeId);
    if (idx === -1) return [];
    return routes.splice(idx, 1);
  }

  // ---- event_routes ---------------------------------------------------------------------
  if (sql.startsWith("DELETE FROM event_routes WHERE event_id")) {
    const [eventId] = p as [string];
    const removed = eventRoutes.filter((er) => er.event_id === eventId);
    for (const row of removed) eventRoutes.splice(eventRoutes.indexOf(row), 1);
    return removed;
  }
  if (sql.startsWith("DELETE FROM event_routes WHERE route_id")) {
    const [routeId] = p as [number];
    const removed = eventRoutes.filter((er) => er.route_id === routeId);
    for (const row of removed) eventRoutes.splice(eventRoutes.indexOf(row), 1);
    return removed;
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
  if (sql.startsWith("SELECT r.id, r.owner_id") && sql.includes("FROM event_routes er")) {
    const [eventId] = p as [string];
    const link = eventRoutes
      .filter((er) => er.event_id === eventId)
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0];
    if (!link) return [];
    const route = routes.find((r) => r.id === link.route_id);
    return route ? [routeWithOwner(route, false)] : [];
  }

  // ---- the other two participant status axes ---------------------------------------------
  if (sql.startsWith("WITH updated AS ( UPDATE event_participants SET attendance_status")) {
    const [id, eventId, status] = p as [number, string, AttendanceStatus];
    const row = eventParticipants.find((r) => r.id === id && r.event_id === eventId);
    if (!row) return [];
    row.attendance_status = status;
    return [withUserDisplay(row)];
  }
  if (sql.startsWith("WITH updated AS ( UPDATE event_participants SET result_status")) {
    const [id, eventId, status, finishedAt, finishPosition] = p as [
      number,
      string,
      ResultStatus,
      Date | null,
      number | null,
    ];
    const row = eventParticipants.find((r) => r.id === id && r.event_id === eventId);
    if (!row) return [];
    row.result_status = status;
    row.finished_at = finishedAt;
    row.finish_position = finishPosition;
    return [withUserDisplay(row)];
  }

  // ---- participant_tracks and the raw points they are built from --------------------------
  if (sql.startsWith("SELECT lp.participant_id,")) {
    const [eventId] = p as [string];
    const participantIds = new Set(
      eventParticipants.filter((ep) => ep.event_id === eventId).map((ep) => ep.id),
    );
    return locationPoints
      .filter((lp) => participantIds.has(lp.participant_id))
      .sort(
        (a, b) =>
          a.participant_id - b.participant_id ||
          a.recorded_at.getTime() - b.recorded_at.getTime(),
      )
      .map((lp) => ({
        participant_id: lp.participant_id,
        lat: lp.lat,
        lng: lp.lng,
        recorded_at: lp.recorded_at,
        emergency: lp.emergency,
      }));
  }
  if (sql.startsWith("INSERT INTO participant_tracks")) {
    const [eventId, participantId, points, pointCount, distanceKm, startedAt, endedAt, hadEmergency] =
      p as [string, number, string, number, number, Date | null, Date | null, boolean];
    const existing = participantTracks.find(
      (t) => t.event_id === eventId && t.participant_id === participantId,
    );
    const values = {
      points: JSON.parse(points),
      point_count: pointCount,
      distance_km: distanceKm,
      started_at: startedAt,
      ended_at: endedAt,
      had_emergency: hadEmergency,
    };
    // ON CONFLICT (event_id, participant_id) DO UPDATE — finishing twice must not duplicate.
    if (existing) {
      Object.assign(existing, values);
      return [existing];
    }
    const row: ParticipantTrackRow = {
      id: nextId.track++,
      event_id: eventId,
      participant_id: participantId,
      created_at: new Date(),
      ...values,
    };
    participantTracks.push(row);
    return [row];
  }
  if (sql.startsWith("SELECT * FROM participant_tracks WHERE event_id = $1 AND participant_id")) {
    const [eventId, participantId] = p as [string, number];
    return participantTracks.filter(
      (t) => t.event_id === eventId && t.participant_id === participantId,
    );
  }
  if (sql.startsWith("SELECT * FROM participant_tracks WHERE event_id")) {
    const [eventId] = p as [string];
    return participantTracks
      .filter((t) => t.event_id === eventId)
      .sort((a, b) => a.participant_id - b.participant_id);
  }
  if (sql.startsWith("SELECT participant_id, distance_travelled_km")) {
    const [eventId] = p as [string];
    return participantLastLocations
      .filter((l) => l.event_id === eventId)
      .map((l) => ({ participant_id: l.participant_id, distance_km: l.distance_travelled_km }));
  }

  // ---- client_actions (offline replay de-duplication) -------------------------------------
  if (sql.startsWith("INSERT INTO client_actions")) {
    const [clientActionId, userId, eventId, actionType] = p as [
      string,
      number | null,
      string | null,
      string | null,
    ];
    // ON CONFLICT (client_action_id) DO NOTHING — the whole mechanism rests on this.
    if (clientActions.some((a) => a.client_action_id === clientActionId)) return [];
    const row: ClientActionRow = {
      client_action_id: clientActionId,
      user_id: userId,
      event_id: eventId,
      action_type: actionType,
      created_at: new Date(),
      response_status: null,
      response_body: null,
    };
    clientActions.push(row);
    return [row];
  }
  if (sql.startsWith("SELECT response_status, response_body FROM client_actions")) {
    const [clientActionId] = p as [string];
    return clientActions.filter((a) => a.client_action_id === clientActionId);
  }
  if (sql.startsWith("UPDATE client_actions")) {
    const [clientActionId, status, body] = p as [string, number, string | null];
    const row = clientActions.find((a) => a.client_action_id === clientActionId);
    if (!row) return [];
    row.response_status = status;
    row.response_body = body === null ? null : JSON.parse(body);
    return [row];
  }
  if (sql.startsWith("DELETE FROM client_actions")) {
    const [clientActionId] = p as [string];
    const idx = clientActions.findIndex((a) => a.client_action_id === clientActionId);
    if (idx === -1) return [];
    return clientActions.splice(idx, 1);
  }

  // ---- event_groups -----------------------------------------------------------------------
  if (sql.startsWith("SELECT * FROM event_groups WHERE event_id = $1 ORDER BY")) {
    const [eventId] = p as [string];
    return eventGroups
      .filter((g) => g.event_id === eventId)
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  }
  if (sql.startsWith("SELECT * FROM event_groups WHERE id = $1 AND event_id")) {
    const [groupId, eventId] = p as [number, string];
    return eventGroups.filter((g) => g.id === groupId && g.event_id === eventId);
  }
  if (sql.startsWith("SELECT COUNT(*)::text AS count FROM event_groups")) {
    const [eventId] = p as [string];
    return [{ count: String(eventGroups.filter((g) => g.event_id === eventId).length) }];
  }
  if (sql.startsWith("SELECT id FROM event_groups WHERE event_id")) {
    const [eventId] = p as [string];
    return eventGroups.filter((g) => g.event_id === eventId).map((g) => ({ id: g.id }));
  }
  if (sql.startsWith("INSERT INTO event_groups")) {
    const [eventId, name, startsAt, routeId, sortOrder] = p as [
      string,
      string,
      Date | null,
      number | null,
      number,
    ];
    const now = new Date();
    const row: EventGroupRow = {
      id: nextId.group++,
      event_id: eventId,
      name,
      starts_at: startsAt,
      route_id: routeId,
      sort_order: sortOrder,
      created_at: now,
      updated_at: now,
    };
    eventGroups.push(row);
    return [row];
  }
  if (sql.startsWith("UPDATE event_groups")) {
    const [groupId, eventId, name, clearStartsAt, startsAt, clearRouteId, routeId, sortOrder] =
      p as [number, string, string | null, boolean, Date | null, boolean, number | null, number | null];
    const row = eventGroups.find((g) => g.id === groupId && g.event_id === eventId);
    if (!row) return [];
    row.name = name ?? row.name;
    // The CASE WHEN $n THEN NULL branches — an explicit clear beats a COALESCE.
    row.starts_at = clearStartsAt ? null : (startsAt ?? row.starts_at);
    row.route_id = clearRouteId ? null : (routeId ?? row.route_id);
    row.sort_order = sortOrder ?? row.sort_order;
    row.updated_at = new Date();
    return [row];
  }
  if (sql.startsWith("DELETE FROM event_groups")) {
    const [groupId, eventId] = p as [number, string];
    const idx = eventGroups.findIndex((g) => g.id === groupId && g.event_id === eventId);
    if (idx === -1) return [];
    return eventGroups.splice(idx, 1);
  }
  if (sql.startsWith("UPDATE event_participants SET group_id = NULL WHERE group_id")) {
    const [groupId] = p as [number];
    const affected = eventParticipants.filter((ep) => ep.group_id === groupId);
    for (const row of affected) row.group_id = null;
    return affected;
  }
  if (sql.startsWith("UPDATE event_participants SET group_id = $3")) {
    const [eventId, participantIds, groupId] = p as [string, number[], number | null];
    const affected = eventParticipants.filter(
      (ep) => ep.event_id === eventId && participantIds.includes(ep.id),
    );
    for (const row of affected) row.group_id = groupId;
    return affected;
  }

  // ---- teams ------------------------------------------------------------------------------
  function memberWithDisplay(row: TeamMemberRow): Row {
    const user = row.user_id === null ? undefined : users.find((u) => u.id === row.user_id);
    const fullName = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
    return {
      ...row,
      display_name: row.name ?? (fullName || null) ?? user?.nickname ?? null,
      avatar_url: user?.avatar_url ?? null,
    };
  }

  if (sql.startsWith("INSERT INTO teams")) {
    const [name, ownerId, avatarUrl] = p as [string, number, string | null];
    const now = new Date();
    const row: TeamRow = {
      id: nextId.team++,
      name,
      owner_id: ownerId,
      avatar_url: avatarUrl,
      created_at: now,
      updated_at: now,
    };
    teams.push(row);
    return [row];
  }
  if (sql.startsWith("SELECT * FROM teams WHERE id")) {
    const [teamId] = p as [number];
    return teams.filter((t) => t.id === teamId);
  }
  if (sql.startsWith("SELECT COUNT(*)::text AS count FROM teams")) {
    const [ownerId] = p as [number];
    return [{ count: String(teams.filter((t) => t.owner_id === ownerId).length) }];
  }
  if (sql.startsWith("SELECT DISTINCT t.* FROM teams t")) {
    const [userId] = p as [number];
    const memberOf = new Set(
      teamMembers
        .filter((m) => m.user_id === userId && m.status === "approved")
        .map((m) => m.team_id),
    );
    return teams
      .filter((t) => t.owner_id === userId || memberOf.has(t.id))
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  }
  if (sql.startsWith("UPDATE teams")) {
    const [teamId, name, avatarUrl] = p as [number, string | null, string | null];
    const row = teams.find((t) => t.id === teamId);
    if (!row) return [];
    row.name = name ?? row.name;
    row.avatar_url = avatarUrl ?? row.avatar_url;
    row.updated_at = new Date();
    return [row];
  }
  if (sql.startsWith("UPDATE events SET team_id = NULL WHERE team_id")) {
    const [teamId] = p as [number];
    const affected = events.filter((e) => e.team_id === teamId);
    for (const row of affected) row.team_id = null;
    return affected;
  }
  if (sql.startsWith("DELETE FROM team_members WHERE team_id")) {
    const [teamId] = p as [number];
    const removed = teamMembers.filter((m) => m.team_id === teamId);
    for (const row of removed) teamMembers.splice(teamMembers.indexOf(row), 1);
    return removed;
  }
  if (sql.startsWith("DELETE FROM teams WHERE id")) {
    const [teamId] = p as [number];
    const idx = teams.findIndex((t) => t.id === teamId);
    if (idx === -1) return [];
    return teams.splice(idx, 1).map((t) => ({ id: t.id }));
  }
  if (sql.startsWith("SELECT tm.*,") && sql.includes("WHERE tm.team_id = $1 AND tm.user_id")) {
    const [teamId, userId] = p as [number, number];
    return teamMembers
      .filter((m) => m.team_id === teamId && m.user_id === userId)
      .map(memberWithDisplay);
  }
  if (sql.startsWith("SELECT tm.*,") && sql.includes("WHERE tm.id = $1 AND tm.team_id")) {
    const [memberId, teamId] = p as [number, number];
    return teamMembers
      .filter((m) => m.id === memberId && m.team_id === teamId)
      .map(memberWithDisplay);
  }
  if (sql.startsWith("SELECT tm.*,") && sql.includes("WHERE tm.team_id = $1")) {
    const [teamId] = p as [number];
    return teamMembers
      .filter((m) => m.team_id === teamId)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .map(memberWithDisplay);
  }
  if (sql.startsWith("WITH inserted AS ( INSERT INTO team_members")) {
    const [teamId, userId, name, email, phone, status] = p as [
      number,
      number | null,
      string | null,
      string | null,
      string | null,
      string,
    ];
    const now = new Date();
    const row: TeamMemberRow = {
      id: nextId.teamMember++,
      team_id: teamId,
      user_id: userId,
      name,
      email,
      phone,
      status,
      created_at: now,
      updated_at: now,
    };
    teamMembers.push(row);
    return [memberWithDisplay(row)];
  }
  if (sql.startsWith("WITH updated AS ( UPDATE team_members SET status")) {
    const [memberId, teamId, status] = p as [number, number, string];
    const row = teamMembers.find((m) => m.id === memberId && m.team_id === teamId);
    if (!row) return [];
    row.status = status;
    row.updated_at = new Date();
    return [memberWithDisplay(row)];
  }
  if (sql.startsWith("DELETE FROM team_members WHERE id")) {
    const [memberId, teamId] = p as [number, number];
    const idx = teamMembers.findIndex((m) => m.id === memberId && m.team_id === teamId);
    if (idx === -1) return [];
    return teamMembers.splice(idx, 1);
  }
  if (sql.startsWith("UPDATE events SET team_id = $2")) {
    const [eventId, teamId] = p as [string, number | null];
    const row = events.find((e) => e.id === eventId);
    if (!row) return [];
    row.team_id = teamId;
    row.updated_at = new Date();
    return [row];
  }
  if (sql.startsWith("SELECT * FROM events WHERE team_id")) {
    const [teamId] = p as [number];
    return events.filter((e) => e.team_id === teamId && e.status !== "cancelled");
  }

  // ---- user_follows -------------------------------------------------------------------------
  if (sql.startsWith("INSERT INTO user_follows")) {
    const [followerId, followeeId] = p as [number, number];
    if (userFollows.some((f) => f.follower_id === followerId && f.followee_id === followeeId)) {
      return [];
    }
    const row: UserFollowRow = {
      follower_id: followerId,
      followee_id: followeeId,
      created_at: new Date(),
    };
    userFollows.push(row);
    return [row];
  }
  if (sql.startsWith("DELETE FROM user_follows")) {
    const [followerId, followeeId] = p as [number, number];
    const idx = userFollows.findIndex(
      (f) => f.follower_id === followerId && f.followee_id === followeeId,
    );
    if (idx === -1) return [];
    return userFollows.splice(idx, 1);
  }
  if (sql.startsWith("SELECT followee_id FROM user_follows")) {
    const [followerId] = p as [number];
    return userFollows
      .filter((f) => f.follower_id === followerId)
      .map((f) => ({ followee_id: f.followee_id }));
  }
  if (sql.startsWith("SELECT COUNT(*)::text AS count FROM user_follows")) {
    const [followeeId] = p as [number];
    return [{ count: String(userFollows.filter((f) => f.followee_id === followeeId).length) }];
  }
  // ---- authorization: roles, event membership, entitlements, coupons ----------------------
  if (sql.startsWith("SELECT role FROM users WHERE id")) {
    const [userId] = p as [number];
    return users.filter((u) => u.id === userId).map((u) => ({ role: u.role }));
  }
  if (sql.startsWith("SELECT role FROM event_members")) {
    const [eventId, userId] = p as [string, number];
    return eventMembers
      .filter((m) => m.event_id === eventId && m.user_id === userId)
      .map((m) => ({ role: m.role }));
  }
  if (sql.startsWith("INSERT INTO event_members")) {
    const [eventId, userId, role] = p as [string, number, string];
    const existing = eventMembers.find((m) => m.event_id === eventId && m.user_id === userId);
    if (existing) {
      existing.role = role;
      return [existing];
    }
    const row: EventMemberRow = { event_id: eventId, user_id: userId, role };
    eventMembers.push(row);
    return [row];
  }
  if (sql.startsWith("SELECT registration_status FROM event_participants")) {
    const [eventId, userId] = p as [string, number];
    return eventParticipants
      .filter((ep) => ep.event_id === eventId && ep.user_id === userId)
      .map((ep) => ({ registration_status: ep.registration_status }));
  }

  function grantIsLive(g: EntitlementGrantRow, now: Date): boolean {
    return (
      g.revoked_at === null &&
      g.starts_at <= now &&
      (g.expires_at === null || g.expires_at > now) &&
      (g.quantity === null || g.consumed < g.quantity) &&
      g.scope_type === null
    );
  }

  if (sql.startsWith("SELECT * FROM entitlement_grants")) {
    const [userId] = p as [number];
    const now = new Date();
    return entitlementGrants
      .filter((g) => g.user_id === userId && grantIsLive(g, now))
      .sort((a, b) => a.id - b.id);
  }
  if (sql.startsWith("UPDATE entitlement_grants")) {
    // The conditional consume: only a live, consumable, unspent grant may be spent.
    const [userId, feature] = p as [number, string];
    const now = new Date();
    const row = entitlementGrants
      .filter(
        (g) =>
          g.user_id === userId &&
          g.feature === feature &&
          g.quantity !== null &&
          g.consumed < g.quantity &&
          grantIsLive(g, now),
      )
      .sort((a, b) => a.id - b.id)[0];
    if (!row) return [];
    row.consumed += 1;
    return [{ id: row.id }];
  }
  if (sql.startsWith("INSERT INTO entitlement_grants")) {
    const [userId, planCode, feature, quantity, source, sourceRef, expiresAt] = p as [
      number,
      string | null,
      string | null,
      number | null,
      string,
      string | null,
      Date | null,
    ];
    const row: EntitlementGrantRow = {
      id: nextId.grant++,
      user_id: userId,
      plan_code: planCode,
      feature,
      quantity,
      consumed: 0,
      scope_type: null,
      scope_id: null,
      source,
      source_ref: sourceRef,
      starts_at: new Date(Date.now() - 1000),
      expires_at: expiresAt,
      revoked_at: null,
    };
    entitlementGrants.push(row);
    return [row];
  }
  if (sql.startsWith("SELECT * FROM coupons WHERE code")) {
    const [code] = p as [string];
    return coupons.filter((c) => c.code === code);
  }
  if (sql.startsWith("SELECT user_id FROM coupon_redemptions")) {
    const [code, userId] = p as [string, number];
    return couponRedemptions
      .filter((r) => r.coupon_code === code && r.user_id === userId)
      .map((r) => ({ user_id: r.user_id }));
  }
  if (sql.startsWith("INSERT INTO coupon_redemptions")) {
    const [code, userId, grantId] = p as [string, number, number];
    const row: CouponRedemptionRow = {
      coupon_code: code,
      user_id: userId,
      grant_id: grantId,
      redeemed_at: new Date(),
    };
    couponRedemptions.push(row);
    return [row];
  }
  if (sql.startsWith("UPDATE coupons SET redeemed_count")) {
    const [code] = p as [string];
    const row = coupons.find((c) => c.code === code);
    if (!row) return [];
    row.redeemed_count += 1;
    return [row];
  }
  if (sql.startsWith("SELECT COUNT(*)::text AS count FROM teams")) {
    const [ownerId] = p as [number];
    return [{ count: String(teams.filter((t) => t.owner_id === ownerId).length) }];
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
