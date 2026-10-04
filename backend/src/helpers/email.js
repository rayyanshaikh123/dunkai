import { env } from '../config/env.js';
import nodemailer from 'nodemailer';

let transporter;

export const sendEmail = async ({ to, subject, html, text }) => {
  if (!env.emailHost) {
    if (env.isProduction) throw new Error('EMAIL_HOST is required to send account email');
    // Development mode only: show the link in the local server log.
    console.info('\n========== EMAIL (DEV MODE) ==========');
    console.info(`To: ${to}`);
    console.info(`Subject: ${subject}`);
    console.info(`Body: ${text || html}`);
    console.info('======================================\n');
    return { sent: false, dev: true };
  }

  transporter ??= nodemailer.createTransport({
    host: env.emailHost,
    port: env.emailPort,
    secure: env.emailPort === 465,
    auth: env.emailUser && env.emailPass ? { user: env.emailUser, pass: env.emailPass } : undefined,
  });
  await transporter.sendMail({ from: env.emailFrom, to, subject, html, text });
  return { sent: true };
};

export const sendPasswordResetEmail = async (email, resetToken) => {
  const resetUrl = `${env.clientOrigin}/reset-password?token=${resetToken}`;
  const html = `
    <h2>Reset your DunkAI password</h2>
    <p>Click the link below to reset your password. This link expires in ${env.resetTokenExpiry} minutes.</p>
    <a href="${resetUrl}">${resetUrl}</a>
    <p>If you didn't request this, you can safely ignore this email.</p>
  `;
  return sendEmail({ to: email, subject: 'DunkAI — Password Reset', html });
};

export const sendVerificationEmail = async (email, verificationToken) => {
  const verifyUrl = `${env.clientOrigin}/verify-email?token=${verificationToken}&email=${encodeURIComponent(email)}`;
  const html = `
    <h2>Verify your DunkAI email</h2>
    <p>Click the link below to verify your email address.</p>
    <a href="${verifyUrl}">${verifyUrl}</a>
  `;
  return sendEmail({ to: email, subject: 'DunkAI — Verify Your Email', html });
};
