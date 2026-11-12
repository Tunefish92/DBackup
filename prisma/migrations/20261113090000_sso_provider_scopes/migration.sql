-- DBackup saved the scopes of a provider as `scope`, a key the SSO plugin of better-auth never
-- reads, so it asked every provider for `offline_access` too, and Google refused the sign-in.
-- Every provider now names the scopes a sign-in needs under `scopes`.
UPDATE "SsoProvider"
SET "oidcConfig" = json_remove(json_set("oidcConfig", '$.scopes', json('["openid","profile","email"]')), '$.scope')
WHERE "oidcConfig" IS NOT NULL
  AND json_valid("oidcConfig")
  AND json_type("oidcConfig", '$.scopes') IS NULL;
