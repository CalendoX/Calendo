CREATE TYPE "public"."organization_plan" AS ENUM('free', 'premium', 'custom');--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "plan" "organization_plan" DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "approved_at";