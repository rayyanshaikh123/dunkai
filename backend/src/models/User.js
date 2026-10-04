import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    password: {
      type: String,
      select: false,
      // Not required because Google OAuth users may not have a password
    },
    avatar: { type: String, default: '' },

    // Auth provider
    provider: { type: String, enum: ['local', 'google'], default: 'local' },
    googleId: { type: String, index: true, sparse: true },

    // Role-based access
    role: { type: String, enum: ['user', 'admin'], default: 'user' },

    // Email verification
    isVerified: { type: Boolean, default: false },
    emailVerificationToken: { type: String, select: false },
    emailVerificationExpires: { type: Date, select: false },

    // Password reset
    resetPasswordToken: { type: String, select: false },
    resetPasswordExpires: { type: Date, select: false },

    // Subscription
    subscription: {
      plan: { type: String, enum: ['free', 'pro', 'enterprise'], default: 'free' },
      status: { type: String, enum: ['active', 'cancelled', 'past_due'], default: 'active' },
      seats: { type: Number, default: 1 },
    },

    // BYOK: the user's own provider keys, AES-256-GCM encrypted
    // (utils/secrets.js). Never selected by default and never serialised; the
    // only way out is services/apiKey.service.js, which sends masked values to
    // the browser and plaintext to the AI engine only.
    apiKeys: {
      type: Map,
      of: new mongoose.Schema(
        {
          encrypted: { type: String, required: true },
          masked: { type: String, required: true },
          verifiedAt: { type: Date },
        },
        { _id: false }
      ),
      default: undefined,
      select: false,
    },

    // Activity
    lastLogin: { type: Date },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret) => {
        delete ret.password;
        delete ret.__v;
        delete ret.resetPasswordToken;
        delete ret.resetPasswordExpires;
        delete ret.emailVerificationToken;
        delete ret.emailVerificationExpires;
        delete ret.apiKeys;
        return ret;
      },
    },
  }
);

userSchema.methods.hasPassword = function () {
  return Boolean(this.password);
};

export const User = mongoose.model('User', userSchema);
