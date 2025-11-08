import { db } from '../config/firebase.js';

/**
 * Combined Authentication + Rate Limiting Middleware
 * 
 * Flow:
 * 1. Extract OAuth token from Authorization header
 * 2. Verify token with Google's tokeninfo endpoint or Microsoft Graph API (based on calendar type)
 * 3. Get user's email from token
 * 4. Check rate limit in Firestore (by email)
 * 5. Increment usage counter atomically
 * 6. Attach user info to req.user
 * 7. Set req.token for use in route handlers
 */
const authAndRateLimit = async (req, res, next) => {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Missing or invalid authorization header'
      });
    }

    const token = authHeader.split('Bearer ')[1];
    
    // Set req.token for use in route handlers
    req.token = token;
    
    // Determine calendar type from query parameter
    const calendarType = req.query.type || null;
    
    // Verify the OAuth token based on calendar type
    let userEmail, userId;
    try {
      if (calendarType === 'outlook') {
        // Verify Outlook token with Microsoft Graph API
        const response = await fetch('https://graph.microsoft.com/v1.0/me', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (!response.ok) {
          throw new Error('Invalid Outlook token');
        }
        
        const userInfo = await response.json();
        userEmail = userInfo.mail || userInfo.userPrincipalName;
        userId = userInfo.id;
        
        if (!userEmail) {
          throw new Error('Email not found in Outlook token');
        }
      } else {
        // Verify Google token with Google's tokeninfo endpoint
        const response = await fetch(`https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${token}`);
        
        if (!response.ok) {
          throw new Error('Invalid Google token');
        }
        
        const tokenInfo = await response.json();
        userEmail = tokenInfo.email;
        userId = tokenInfo.user_id;
        
        if (!userEmail) {
          throw new Error('Email not found in Google token');
        }
      }
    } catch (error) {
      console.error('❌ Token verification failed:', error.message);
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid or expired token'
      });
    }

    console.log(`🔐 Authenticated user: ${userEmail} (UID: ${userId})`);

    // Skip rate limiting for onboarding endpoints
    if (req.path.startsWith('/onboarding')) {
      req.user = {
        uid: userId,
        email: userEmail
      };
      return next();
    }

    // Check rate limit in Firestore (using nested user doc structure)
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    const userDocRef = db.collection('users').doc(userEmail);
    const userLimitRef = userDocRef.collection('configs').doc('limits');

    // Use a transaction to ensure atomic read + write
    try {
      const result = await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(userLimitRef);
        
        let usage = 0;
        let limit = 10; // Default daily limit
        let lastReset = today;

        if (doc.exists) {
          const data = doc.data();
          lastReset = data.lastReset || today;
          limit = data.limit || 10;
          usage = data.usage || 0;

          // Reset counter if it's a new day
          if (lastReset !== today) {
            usage = 0;
            lastReset = today;
          }
        }

        // Check if user has exceeded limit
        if (usage >= limit) {
          return { exceeded: true, usage, limit };
        }

        // Increment usage counter
        transaction.set(userDocRef, {
          email: userEmail,
          uid: userId
        }, { merge: true });

        transaction.set(userLimitRef, {
          usage: usage + 1,
          limit: limit,
          lastReset: lastReset
        }, { merge: true });

        return { exceeded: false, usage: usage + 1, limit };
      });

      if (result.exceeded) {
        console.log(`⚠️ Rate limit exceeded for ${userEmail}: ${result.usage}/${result.limit}`);
        
        // For SSE endpoints, send as SSE event
        if (req.path.includes('/stream')) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Cache-Control'
          });
          
          const sseEvent = {
            type: 'response',
            response: "You've reached your maximum usage for today! Checkin tomorrow, or consider upgrading to Kalendra Plus!",
            usage: result.usage,
            limit: result.limit
          };
          
          res.write(`data: ${JSON.stringify(sseEvent)}\n\n`);
          res.end();
          return;
        }
        
        // For regular endpoints, send JSON response
        return res.status(200).json({
          success: false,
          type: 'response',
          response: "You've reached your maximum usage for today! Checkin tomorrow, or consider upgrading to Kalendra Plus!",
          error: 'Rate limit exceeded',
          usage: result.usage,
          limit: result.limit
        });
      }

      console.log(`✅ Rate limit check passed for ${userEmail}: ${result.usage}/${result.limit}`);

      // Attach user info to request for use in route handlers
      req.user = {
        uid: userId,
        email: userEmail,
        usage: result.usage,
        limit: result.limit
      };

      next();
    } catch (error) {
      console.error('❌ Rate limit check failed:', error);
      return res.status(500).json({
        success: false,
        error: 'Internal server error during rate limit check'
      });
    }

  } catch (error) {
    console.error('❌ Auth middleware error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error during authentication'
    });
  }
};

export default authAndRateLimit;

