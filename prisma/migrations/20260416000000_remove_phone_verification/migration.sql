-- Remove phone verification columns from users
DROP INDEX IF EXISTS "users_phone_key";
ALTER TABLE "users" DROP COLUMN IF EXISTS "phone";
ALTER TABLE "users" DROP COLUMN IF EXISTS "phone_verified";
