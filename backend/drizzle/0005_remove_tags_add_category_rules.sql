CREATE TABLE `category_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`category` text NOT NULL,
	`rule_type` text NOT NULL,
	`rule_value` text NOT NULL,
	`priority` integer DEFAULT 0,
	`enabled` integer DEFAULT 1,
	`created_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
DROP TABLE IF EXISTS `activity_tags`;
--> statement-breakpoint
DROP TABLE IF EXISTS `tagging_rules`;
--> statement-breakpoint
DROP TABLE IF EXISTS `tags`;
