CREATE TABLE IF NOT EXISTS model_access_catalog (
    id              VARCHAR(128) PRIMARY KEY,
    public_info     JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS model_access_plan (
    code            VARCHAR(32) PRIMARY KEY,
    name            VARCHAR(64) NOT NULL,
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS model_access_plan_one_default
    ON model_access_plan (is_default) WHERE is_default;

CREATE TABLE IF NOT EXISTS model_access_plan_model (
    plan_code       VARCHAR(32) NOT NULL REFERENCES model_access_plan(code) ON DELETE CASCADE,
    model_id        VARCHAR(128) NOT NULL REFERENCES model_access_catalog(id) ON DELETE CASCADE,
    PRIMARY KEY (plan_code, model_id)
);

CREATE TABLE IF NOT EXISTS model_access_user (
    email           VARCHAR(320) PRIMARY KEY,
    plan_code       VARCHAR(32) NOT NULL REFERENCES model_access_plan(code),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO model_access_plan(code, name, is_default) VALUES
    ('free', 'Free', TRUE),
    ('plus', 'Plus', FALSE),
    ('pro', 'Pro', FALSE)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS model_access_sync_task (
    id BIGSERIAL PRIMARY KEY, reason VARCHAR(128) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending', total_count INTEGER NOT NULL DEFAULT 0,
    processed_count INTEGER NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS model_access_sync_item (
    id BIGSERIAL PRIMARY KEY, task_id BIGINT NOT NULL REFERENCES model_access_sync_task(id) ON DELETE CASCADE,
    email VARCHAR(320) NOT NULL, model_ids TEXT[] NOT NULL DEFAULT '{}',
    status VARCHAR(16) NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS model_access_sync_item_pending ON model_access_sync_item(status, id);
