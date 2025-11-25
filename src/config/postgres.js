import pg from 'pg';
import logger from '../utils/appLogger.js';

let pool;

function getEnvVars() {
  return {
    LOG_DB_HOST: process.env.LOG_DB_HOST,
    LOG_DB_PORT: process.env.LOG_DB_PORT,
    LOG_DB_USER: process.env.LOG_DB_USER,
    LOG_DB_PASSWORD: process.env.LOG_DB_PASSWORD,
    LOG_DB_DATABASE: process.env.LOG_DB_DATABASE,
    LOG_DB_SSL: process.env.LOG_DB_SSL
  };
}

export function getLogDbPool() {
  if (pool) {
    return pool;
  }

  const env = getEnvVars();
  if (!env.LOG_DB_HOST || !env.LOG_DB_USER || !env.LOG_DB_DATABASE) {
    logger.warn('[logging] PostgreSQL logging is disabled (missing LOG_DB_* env vars)', { 
      hasHost: !!env.LOG_DB_HOST, 
      hasUser: !!env.LOG_DB_USER, 
      hasDatabase: !!env.LOG_DB_DATABASE 
    });
    return null;
  }

  pool = new pg.Pool({
    host: env.LOG_DB_HOST,
    port: env.LOG_DB_PORT ? Number(env.LOG_DB_PORT) : 5432,
    user: env.LOG_DB_USER,
    password: env.LOG_DB_PASSWORD,
    database: env.LOG_DB_DATABASE,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: env.LOG_DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
  });

  pool.on('error', (err) => {
    logger.error({ type: 'POSTGRES_POOL_ERROR', error: err.message });
  });

  logger.info('[logging] PostgreSQL logging pool initialized');
  return pool;
}

export function isLoggingEnabled() {
  const env = getEnvVars();
  return Boolean(env.LOG_DB_HOST && env.LOG_DB_USER && env.LOG_DB_DATABASE);
}

