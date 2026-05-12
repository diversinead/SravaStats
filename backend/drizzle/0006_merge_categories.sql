-- Reduce the trainingCategory vocabulary from 17 values to 11 and fold legacy
-- surface-labelled buckets into the closest intent bucket.
--
--   Tempo, Road Workout, Gravel Workout  -> Threshold
--   Track Workout, Fartlek, Grass Track  -> Intervals
--   Strides                              -> WU/CD
UPDATE `activities`
SET `training_category` = 'Threshold'
WHERE `training_category` IN ('Tempo', 'Road Workout', 'Gravel Workout');
--> statement-breakpoint
UPDATE `activities`
SET `training_category` = 'Intervals'
WHERE `training_category` IN ('Track Workout', 'Fartlek', 'Grass Track');
--> statement-breakpoint
UPDATE `activities`
SET `training_category` = 'WU/CD'
WHERE `training_category` = 'Strides';
--> statement-breakpoint
UPDATE `category_rules`
SET `category` = 'Threshold'
WHERE `category` IN ('Tempo', 'Road Workout', 'Gravel Workout');
--> statement-breakpoint
UPDATE `category_rules`
SET `category` = 'Intervals'
WHERE `category` IN ('Track Workout', 'Fartlek', 'Grass Track');
--> statement-breakpoint
UPDATE `category_rules`
SET `category` = 'WU/CD'
WHERE `category` = 'Strides';
