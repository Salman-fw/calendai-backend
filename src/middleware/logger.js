import crypto from 'crypto';

// Request logging middleware
export function requestLogger(req, res, next) {
  const requestId = crypto.randomBytes(8).toString('hex');
  const startTime = Date.now();

  // Attach request ID to request object
  req.requestId = requestId;

  // Log incoming request
  console.log(JSON.stringify({
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
  }));

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
  
  console.log(JSON.stringify({
    type: 'RESPONSE',
    requestId,
    timestamp: new Date().toISOString(),
    statusCode,
    duration: `${duration}ms`,
    body: typeof data === 'string' ? data.substring(0, 200) : data
  }));
}

// Error logging middleware
export function errorLogger(err, req, res, next) {
  console.error(JSON.stringify({
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
  }));

  // Send error response
  res.status(500).json({
    success: false,
    error: err.message,
    requestId: req.requestId
  });
}

