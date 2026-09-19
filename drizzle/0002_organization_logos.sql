CREATE TABLE "organization_logos" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"sha256" text NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_logos" ADD CONSTRAINT "organization_logos_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_logos" ADD CONSTRAINT "organization_logos_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;