import logger from './appLogger.js';
import { logUserEvent } from '../services/loggingService.js';

export async function recordInteractionLog(req, { actionType = 'converse', calendarType, payload = {} }) {
  logger.info({ type: 'RECORD_LOG_CALLED', path: req.path, actionType, hasUser: !!req.user, email: req.user?.email });
  try {
    const email = req.user?.email;
    if (!email) {
      logger.warn({ type: 'SKIP_LOG_NO_EMAIL', path: req.path, hasUser: !!req.user });
      return;
    }
    await logUserEvent({
      email,
      profileInfo: req.user ? { uid: req.user.uid } : null,
      actionType,
      calendarType,
      logPayload: payload
    });
  } catch (error) {
    logger.warn({ type: 'INTERACTION_LOG_FAILURE', error: error.message, stack: error.stack });
  }
}

