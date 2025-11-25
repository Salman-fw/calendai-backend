import crypto from 'crypto';
import logger from '../utils/appLogger.js';

// Request logging middleware
export function requestLogger(req, res, next) {
  const requestId = crypto.randomBytes(8).toString('hex');
  const startTime = Date.now();

  // Attach request ID to request object
  req.requestId = requestId;

  // Log incoming request
  logger.info({
    type: 'REQUEST',
    requestId,
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.path,
    query: req.query,
    headers: {
      'content-type': req.headers['content-type'],
      'user-agent': req.headers['user-agent'],
      'authorization': req.headers.authorization ? 'Bearer ***' : 'none'
    },
    body: req.method !== 'GET' ? sanitizeBody(req.body) : undefined,
    ip: req.ip || req.connection.remoteAddress
  });

  // Capture response (only intercept json since we use it everywhere)
  const originalJson = res.json;
  let logged = false;

  res.json = function(data) {
    if (!logged) {
      logResponse(requestId, startTime, res.statusCode, data);
      logged = true;
    }
    originalJson.call(this, data);
  };

  next();
}

function sanitizeBody(body) {
  if (!body) return undefined;
  
  // Don't log file buffers, just indicate file upload
  if (body.audio) {
    return { ...body, audio: '[FILE_UPLOAD]' };
  }
  
  return body;
}

function logResponse(requestId, startTime, statusCode, data) {
  const duration = Date.now() - startTime;
  
  // Truncate large response bodies (especially calendar events)
  let body = data;
  if (typeof data === 'string') {
    body = data.substring(0, 200);
  } else if (data && typeof data === 'object') {
    // For calendar events, only log summary
    if (data.events && Array.isArray(data.events)) {
      body = {
        ...data,
        events: data.events.length > 5 ? `[${data.events.length} events - truncated]` : data.events
      };
    } else {
      // For other objects, limit to 500 chars when stringified
      const str = JSON.stringify(data);
      if (str.length > 500) {
        // Truncate at a safe position and keep as string
        body = str.substring(0, 500) + '... [truncated]';
      } else {
        body = data;
      }
    }
  }
  
  logger.info({
    type: 'RESPONSE',
    requestId,
    timestamp: new Date().toISOString(),
    statusCode,
    duration: `${duration}ms`,
    body
  });
}

// Error logging middleware
export function errorLogger(err, req, res, next) {
  logger.error({
    type: 'ERROR',
    requestId: req.requestId,
    timestamp: new Date().toISOString(),
    error: {
      message: err.message,
      stack: err.stack,
      name: err.name
    },
    request: {
      method: req.method,
      path: req.path,
      body: sanitizeBody(req.body)
    }
  });

  // Send error response
  res.status(500).json({
    success: false,
    error: err.message,
    requestId: req.requestId
  });
}

