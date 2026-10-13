ALTER TABLE timers ADD COLUMN next_run_generation INTEGER;
ALTER TABLE timers ADD COLUMN next_run_plan_sequence INTEGER NOT NULL DEFAULT 0
  CHECK (next_run_plan_sequence >= 0);
