// Extract and validate OAuth access token from Authorization header
export function extractToken(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      success: false, 
      error: 'No authorization token provided' 
    });
  }
  
  req.token = authHeader.substring(7);
  next();
}

