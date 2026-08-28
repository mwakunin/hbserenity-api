CREATE TABLE "property_rate_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"price_per_night_cents" integer NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_rate_overrides_dates_valid" CHECK ("property_rate_overrides"."end_date" > "property_rate_overrides"."start_date"),
	CONSTRAINT "property_rate_overrides_price_whole" CHECK ("property_rate_overrides"."price_per_night_cents" % 100 = 0 AND "property_rate_overrides"."price_per_night_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "weekend_price_cents" integer;--> statement-breakpoint
ALTER TABLE "property_rate_overrides" ADD CONSTRAINT "property_rate_overrides_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "property_rate_overrides_property_idx" ON "property_rate_overrides" USING btree ("property_id");--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_weekend_price_whole" CHECK ("properties"."weekend_price_cents" IS NULL OR ("properties"."weekend_price_cents" % 100 = 0 AND "properties"."weekend_price_cents" >= 0));