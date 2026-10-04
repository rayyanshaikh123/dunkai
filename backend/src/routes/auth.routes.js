import { Router } from 'express';
import * as c from '../controllers/auth.controller.js';
import { validate } from '../middleware/validation.js';
import { authenticate } from '../middleware/auth.js';
import { authLimiter } from '../middleware/security.js';
import {
  registerValidation,
  loginValidation,
  refreshValidation,
  forgotPasswordValidation,
  resetPasswordValidation,
  changePasswordValidation,
  verifyEmailValidation,
  resendVerificationValidation,
  updateProfileValidation,
} from '../validators/auth.validators.js';

export const authRoutes = Router();

// Public routes
authRoutes.post('/register', authLimiter, registerValidation, validate, c.register);
authRoutes.post('/login', authLimiter, loginValidation, validate, c.login);
authRoutes.post('/refresh', refreshValidation, validate, c.refresh);
authRoutes.post('/logout', c.logout);
authRoutes.post('/forgot-password', authLimiter, forgotPasswordValidation, validate, c.forgotPassword);
authRoutes.post('/reset-password', authLimiter, resetPasswordValidation, validate, c.resetPassword);
authRoutes.post('/verify-email', authLimiter, verifyEmailValidation, validate, c.verifyEmail);
authRoutes.post('/resend-verification', authLimiter, resendVerificationValidation, validate, c.resendVerification);

// Google OAuth
authRoutes.get('/google', c.googleAuth);
authRoutes.get('/google/callback', c.googleCallback);

// Protected routes
authRoutes.get('/me', authenticate, c.me);
authRoutes.get('/socket-token', authenticate, c.socketToken);
authRoutes.put('/profile', authenticate, updateProfileValidation, validate, c.updateProfile);
authRoutes.put('/password', authenticate, changePasswordValidation, validate, c.changePassword);
