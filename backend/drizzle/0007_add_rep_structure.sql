-- Per-activity rep structure. Stores the athlete's workout intent as JSON,
-- e.g. {"mode":"time","reps":3,"repSize":480,"recSec":60} for 3×8min with
-- 1min recoveries. Null = auto-detect at compare time.
ALTER TABLE `activities` ADD `rep_structure` text;
