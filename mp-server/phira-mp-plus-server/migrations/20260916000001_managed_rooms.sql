CREATE TABLE IF NOT EXISTS mp_managed_rooms (
    room_id VARCHAR(20) PRIMARY KEY,
    kind VARCHAR(16) NOT NULL,
    definition JSONB NOT NULL,
    deleted BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mp_managed_rooms_active
    ON mp_managed_rooms (kind, deleted, updated_at);
