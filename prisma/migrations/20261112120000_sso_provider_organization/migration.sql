-- The SSO plugin of better-auth 1.7 checks the table of the providers before every request and
-- refuses every sign-in while a column it knows is missing. organizationId belongs to its
-- organization plugin, which DBackup does not use, so the column stays empty.
ALTER TABLE "SsoProvider" ADD COLUMN "organizationId" TEXT;
