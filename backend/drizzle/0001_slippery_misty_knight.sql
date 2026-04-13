CREATE TABLE `laps` (
	`id` integer PRIMARY KEY NOT NULL,
	`activity_id` integer NOT NULL,
	`lap_index` integer NOT NULL,
	`name` text NOT NULL,
	`custom_name` text,
	`distance` real,
	`moving_time` integer,
	`elapsed_time` integer,
	`average_speed` real,
	`average_heartrate` real,
	`max_heartrate` real,
	`average_cadence` real,
	`total_elevation_gain` real,
	`synced_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_laps_activity_index` ON `laps` (`activity_id`,`lap_index`);