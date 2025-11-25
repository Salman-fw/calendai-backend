import logger from '../utils/appLogger.js';
import { getLogDbPool, isLoggingEnabled } from '../config/postgres.js';

let initPromise = null;

async function ensureSchema() {
  if (!isLoggingEnabled()) {
    return;
  }

  const pool = getLogDbPool();
  if (!pool) {
    return;
  }

  const createSql = `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'calendar_type') THEN
        CREATE TYPE calendar_type AS ENUM ('google', 'outlook');
      END IF;
    END$$;

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'action_type') THEN
        CREATE TYPE action_type AS ENUM (
          'create',
          'update',
          'delete',
          'ask_to_clarify',
          'cancel',
          'approve',
          'converse',
          'unified_calendar'
        );
      END IF;
    END$$;

    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      profile_info JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS logs (
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      log JSONB,
      calendar_type calendar_type,
      action_type varchar NOT NULL,
      PRIMARY KEY (created_at, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_logs_user_id ON logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_logs_action_type ON logs(action_type);
  `;

  try {
    await pool.query(createSql);
    logger.info('[logging] Ensured PostgreSQL logging schema');
  } catch (error) {
    logger.error({ type: 'LOG_SCHEMA_ERROR', error: error.message });
  }
}

export async function initLogging() {
  if (initPromise) {
    return initPromise;
  }
  initPromise = ensureSchema();
  return initPromise;
}

async function upsertUser(client, email, profileInfo) {
  const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rowCount > 0) {
    return existing.rows[0].id;
  }

  const inserted = await client.query(
    'INSERT INTO users (email, profile_info) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id',
    [email, profileInfo || null]
  );

  if (inserted.rowCount > 0) {
    return inserted.rows[0].id;
  }

  // Insert raced with another request; fetch id
  const retry = await client.query('SELECT id FROM users WHERE email = $1', [email]);
  return retry.rows[0]?.id;
}

export async function logUserEvent({
  email,
  profileInfo = null,
  calendarType = null,
  actionType = 'converse',
  logPayload = {}
}) {
  if (!isLoggingEnabled()) {
    logger.warn({ type: 'LOG_SKIP_DISABLED' });
    return;
  }
  if (!email) {
    logger.warn({ type: 'LOG_SKIP_NO_EMAIL' });
    return;
  }

  const pool = getLogDbPool();
  if (!pool) {
    logger.warn({ type: 'LOG_SKIP_NO_POOL' });
    return;
  }

  await initLogging();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = await upsertUser(client, email, profileInfo);
    if (!userId) {
      await client.query('ROLLBACK');
      return;
    }

    await client.query(
      'INSERT INTO logs (user_id, log, calendar_type, action_type) VALUES ($1, $2::jsonb, $3, $4::action_type)',
      [userId, JSON.stringify(logPayload), calendarType || null, actionType]
    );

    await client.query('COMMIT');
    logger.info({ type: 'LOG_INSERT_SUCCESS', email, actionType });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error({ type: 'LOG_INSERT_ERROR', error: error.message, stack: error.stack });
  } finally {
    client.release();
  }
}

