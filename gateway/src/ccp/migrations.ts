import type Database from "better-sqlite3";

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE device (
        id TEXT PRIMARY KEY,
        key_id TEXT NOT NULL UNIQUE,
        member_id TEXT NOT NULL,
        public_key_spki BLOB NOT NULL,
        fingerprint TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'revoked')),
        created_at_ms INTEGER NOT NULL,
        last_seen_at_ms INTEGER,
        revoked_at_ms INTEGER
      );

      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        display_label TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE grant_record (
        id TEXT PRIMARY KEY,
        member_id TEXT,
        device_id TEXT,
        project_id TEXT,
        tool_id TEXT,
        operation_class TEXT NOT NULL CHECK (operation_class IN ('read', 'mutation', 'capture', 'control')),
        expires_at_ms INTEGER,
        status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'revoked')),
        created_at_ms INTEGER NOT NULL,
        CHECK (member_id IS NOT NULL OR device_id IS NOT NULL)
      );

      CREATE TABLE operation_policy (
        tool_id TEXT NOT NULL,
        contract_version INTEGER NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        contract_hash TEXT NOT NULL,
        minimum_relay_build TEXT,
        blocked_relay_builds_json TEXT NOT NULL DEFAULT '[]',
        creator_range TEXT NOT NULL,
        required_consent_version TEXT,
        revision INTEGER NOT NULL,
        PRIMARY KEY (tool_id, contract_version)
      );

      CREATE TABLE relay_cursor (
        device_id TEXT NOT NULL,
        relay_instance_id TEXT NOT NULL,
        last_sequence INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (device_id, relay_instance_id)
      );

      CREATE TABLE request_idempotency (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        relay_instance_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        nonce TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reserved', 'completed')),
        reservation_owner TEXT NOT NULL,
        response_body BLOB,
        response_hash TEXT,
        created_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        expires_at_ms INTEGER NOT NULL,
        UNIQUE (device_id, idempotency_key),
        UNIQUE (device_id, relay_instance_id, nonce),
        CHECK ((state = 'reserved' AND response_body IS NULL AND response_hash IS NULL AND completed_at_ms IS NULL)
          OR (state = 'completed' AND response_body IS NOT NULL AND response_hash IS NOT NULL AND completed_at_ms IS NOT NULL))
      );

      CREATE TABLE release_target (
        sequence INTEGER PRIMARY KEY,
        version TEXT NOT NULL UNIQUE,
        package_hash TEXT NOT NULL UNIQUE,
        compatibility_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'revoked')),
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE rollout_policy (
        sequence INTEGER PRIMARY KEY,
        target_hash TEXT NOT NULL,
        channel TEXT NOT NULL,
        ring TEXT NOT NULL,
        percentage INTEGER NOT NULL CHECK (percentage BETWEEN 0 AND 100),
        minimum_build TEXT,
        blocked_builds_json TEXT NOT NULL DEFAULT '[]',
        rollback_target_hash TEXT,
        expires_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL
      );

      CREATE TABLE ccp_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        correlation_id TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        member_id TEXT,
        device_id TEXT,
        project_id TEXT,
        tool_family TEXT NOT NULL,
        relay_build TEXT,
        result_class TEXT NOT NULL,
        error_code TEXT,
        request_bytes INTEGER NOT NULL,
        response_bytes INTEGER NOT NULL,
        phase_timings_json TEXT NOT NULL
      );

      CREATE INDEX device_member_status_idx ON device(member_id, status);
      CREATE INDEX grant_active_idx ON grant_record(status, member_id, device_id, project_id, tool_id, expires_at_ms);
      CREATE INDEX operation_policy_enabled_idx ON operation_policy(enabled, tool_id, contract_version);
      CREATE INDEX replay_expiry_idx ON request_idempotency(expires_at_ms, state);
      CREATE INDEX release_status_idx ON release_target(status, version);
      CREATE INDEX rollout_channel_idx ON rollout_policy(channel, ring, expires_at_ms);
      CREATE INDEX ccp_audit_time_idx ON ccp_audit(timestamp_ms);
      CREATE INDEX ccp_audit_tool_status_idx ON ccp_audit(tool_family, result_class, timestamp_ms);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE release_target ADD COLUMN target_payload_hash TEXT;
      UPDATE release_target SET target_payload_hash = package_hash WHERE target_payload_hash IS NULL;
      CREATE UNIQUE INDEX release_target_payload_hash_idx ON release_target(target_payload_hash);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE enrollment_challenge (
        challenge_id TEXT PRIMARY KEY,
        challenge_hash TEXT NOT NULL UNIQUE,
        member_id TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        consumed_at_ms INTEGER
      );

      CREATE INDEX enrollment_challenge_expiry_idx
        ON enrollment_challenge(expires_at_ms, consumed_at_ms);

      ALTER TABLE request_idempotency RENAME TO request_idempotency_v2;

      CREATE TABLE request_idempotency (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        relay_instance_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        nonce TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reserved', 'completed', 'failed')),
        reservation_owner TEXT NOT NULL,
        response_body BLOB,
        response_hash TEXT,
        failure_class TEXT,
        created_at_ms INTEGER NOT NULL,
        lease_expires_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        failed_at_ms INTEGER,
        expires_at_ms INTEGER NOT NULL,
        UNIQUE (device_id, idempotency_key),
        UNIQUE (device_id, relay_instance_id, nonce),
        CHECK (
          (state = 'reserved'
            AND response_body IS NULL AND response_hash IS NULL
            AND completed_at_ms IS NULL AND failed_at_ms IS NULL AND failure_class IS NULL)
          OR
          (state = 'completed'
            AND response_body IS NOT NULL AND response_hash IS NOT NULL
            AND completed_at_ms IS NOT NULL AND failed_at_ms IS NULL AND failure_class IS NULL)
          OR
          (state = 'failed'
            AND response_body IS NULL AND response_hash IS NULL
            AND completed_at_ms IS NULL AND failed_at_ms IS NOT NULL AND failure_class IS NOT NULL)
        )
      );

      INSERT INTO request_idempotency(
        id, device_id, relay_instance_id, idempotency_key, request_digest, nonce, sequence,
        state, reservation_owner, response_body, response_hash, failure_class, created_at_ms,
        lease_expires_at_ms, completed_at_ms, failed_at_ms, expires_at_ms
      )
      SELECT
        id, device_id, relay_instance_id, idempotency_key, request_digest, nonce, sequence,
        state, reservation_owner, response_body, response_hash, NULL, created_at_ms,
        expires_at_ms, completed_at_ms, NULL, expires_at_ms
      FROM request_idempotency_v2;

      DROP TABLE request_idempotency_v2;

      CREATE INDEX replay_expiry_idx
        ON request_idempotency(expires_at_ms, state);
      CREATE INDEX replay_lease_idx
        ON request_idempotency(state, lease_expires_at_ms);

      CREATE TABLE canary_health (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_hash TEXT NOT NULL,
        package_hash TEXT NOT NULL,
        device_id TEXT NOT NULL,
        probe_id TEXT NOT NULL,
        observed_at_ms INTEGER NOT NULL,
        ring TEXT NOT NULL CHECK (ring IN ('1', '3', '10')),
        healthy INTEGER NOT NULL CHECK (healthy IN (0, 1)),
        UNIQUE (target_hash, package_hash, device_id, probe_id, observed_at_ms)
      );

      CREATE INDEX canary_health_cohort_idx
        ON canary_health(target_hash, package_hash, ring, observed_at_ms);

      CREATE TABLE rollout_state (
        channel TEXT PRIMARY KEY,
        target_hash TEXT NOT NULL,
        package_hash TEXT NOT NULL,
        ring TEXT NOT NULL CHECK (ring IN ('1', '3', '10')),
        policy_sequence INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      INSERT INTO rollout_state(
        channel, target_hash, package_hash, ring, policy_sequence, updated_at_ms
      )
      SELECT
        policy.channel,
        policy.target_hash,
        COALESCE(target.package_hash, ''),
        policy.ring,
        policy.sequence,
        policy.created_at_ms
      FROM rollout_policy AS policy
      LEFT JOIN release_target AS target
        ON target.target_payload_hash = policy.target_hash
      WHERE policy.sequence = (
        SELECT MAX(candidate.sequence)
        FROM rollout_policy AS candidate
        WHERE candidate.channel = policy.channel
      );
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS ccp_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        correlation_id TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        member_id TEXT,
        device_id TEXT,
        project_id TEXT,
        tool_family TEXT NOT NULL,
        relay_build TEXT,
        result_class TEXT NOT NULL,
        error_code TEXT,
        request_bytes INTEGER NOT NULL,
        response_bytes INTEGER NOT NULL,
        phase_timings_json TEXT NOT NULL
      );
      CREATE TABLE ccp_security_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp_ms INTEGER NOT NULL,
        actor_member_id TEXT,
        event_type TEXT NOT NULL,
        target_id TEXT,
        result_class TEXT NOT NULL CHECK (result_class IN ('ok', 'deny', 'error')),
        error_code TEXT
      );
      CREATE INDEX ccp_security_time_idx ON ccp_security_event(timestamp_ms, id);
      CREATE INDEX ccp_audit_member_time_idx ON ccp_audit(member_id, timestamp_ms);
      CREATE TABLE ccp_usage_hour (
        hour_ms INTEGER NOT NULL,
        member_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        tool_family TEXT NOT NULL,
        relay_build TEXT NOT NULL,
        result_class TEXT NOT NULL,
        error_code TEXT NOT NULL,
        requests INTEGER NOT NULL,
        request_bytes INTEGER NOT NULL,
        response_bytes INTEGER NOT NULL,
        PRIMARY KEY (hour_ms, member_id, device_id, project_id, tool_family, relay_build, result_class, error_code)
      );
      INSERT INTO ccp_usage_hour
      SELECT timestamp_ms - timestamp_ms % 3600000, COALESCE(member_id, ''), COALESCE(device_id, ''),
        COALESCE(project_id, ''), tool_family, COALESCE(relay_build, ''), result_class, COALESCE(error_code, ''),
        COUNT(*), SUM(request_bytes), SUM(response_bytes)
      FROM ccp_audit
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8;
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE rollout_policy ADD COLUMN emergency_stop INTEGER NOT NULL DEFAULT 0 CHECK (emergency_stop IN (0, 1));
      ALTER TABLE rollout_policy ADD COLUMN disabled_operations_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE rollout_policy ADD COLUMN signed_wrapper_json TEXT;
      CREATE INDEX rollout_execution_scope_idx ON rollout_policy(target_hash, channel, sequence DESC);
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE ccp_audit ADD COLUMN request_id TEXT;
      CREATE INDEX ccp_audit_request_idx ON ccp_audit(request_id);
      CREATE TABLE ccp_completion_telemetry (
        request_id TEXT PRIMARY KEY,
        outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'failed', 'outcome-unknown')),
        duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 0 AND 300000),
        error_code TEXT,
        received_at_ms INTEGER NOT NULL
      );
    `,
  },
 ];

export function applyCcBridgeMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ccp_migration (
      version INTEGER PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL
    )
  `);
  const applied = db.prepare("SELECT version FROM ccp_migration").all() as Array<{ version: number }>;
  const versions = new Set(applied.map((row) => row.version));
  const migrate = db.transaction((migration: Migration) => {
    db.exec(migration.sql);
    db.prepare("INSERT INTO ccp_migration(version, applied_at_ms) VALUES (?, ?)")
      .run(migration.version, Date.now());
  });
  for (const migration of MIGRATIONS) {
    if (!versions.has(migration.version)) migrate(migration);
  }
}
