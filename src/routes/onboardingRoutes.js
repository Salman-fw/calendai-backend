import express from 'express';
import { saveOnboardingProfile, getOnboardingProfile } from '../services/onboardingService.js';

const router = express.Router();

router.get('/profile', async (req, res) => {
  try {
    const profile = await getOnboardingProfile(req.user.email);
    res.json({ success: true, profile });
  } catch (error) {
    console.error('Onboarding profile fetch error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch onboarding profile' });
  }
});

router.post('/profile', async (req, res) => {
  try {
    const payload = req.body ?? {};
    const saved = await saveOnboardingProfile(req.user.email, payload);
    res.json({ success: true, profile: saved });
  } catch (error) {
    console.error('Onboarding profile save error:', error);
    res.status(500).json({ success: false, error: 'Failed to save onboarding profile' });
  }
});

export default router;

