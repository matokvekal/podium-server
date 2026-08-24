ccc
SELECT * FROM participant_last_location;

SELECT * FROM participant_tracks;

SELECT * FROM location_points;

SELECT * FROM event_routes;

SELECT * FROM event_participants;

SELECT * FROM event_members;

SELECT * FROM team_members;

SELECT * FROM teams;

SELECT * FROM user_follows;

SELECT * FROM client_actions;

SELECT * FROM entitlement_grants;

SELECT * FROM otp_challenges;

SELECT * FROM sessions;

SELECT * FROM auth_identities;

SELECT * FROM events;

SELECT * FROM routes;

SELECT * FROM users;








TRUNCATE TABLE
  participant_last_location,
  participant_tracks,
  location_points,
  event_routes,
  event_participants,
  event_members,
  team_members,
  teams,
  user_follows,
  client_actions,
  entitlement_grants,
  otp_challenges,
  sessions,
  auth_identities,
  events,
  routes,
  users
RESTART IDENTITY
CASCADE;

///////////////////////////////