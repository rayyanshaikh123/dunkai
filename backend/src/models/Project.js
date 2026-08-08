import mongoose from 'mongoose';

const projectSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, maxlength: 5000, default: '' },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    members: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        role: { type: String, enum: ['viewer', 'editor'], default: 'viewer' },
        addedAt: { type: Date, default: Date.now },
      },
    ],

    status: { type: String, enum: ['active', 'archived'], default: 'active', index: true },
    currentStage: {
      type: String,
      enum: ['requirements', 'architecture', 'components', 'pcb', 'validation', 'documentation'],
      default: 'requirements',
    },
    agentsCompleted: [{ type: String }],

    // Metadata
    tags: [{ type: String, trim: true }],
    isFavourite: { type: Boolean, default: false, index: true },
    isPublic: { type: Boolean, default: false },

    // AI-generated data (stored as flexible mixed objects)
    requirements: { type: mongoose.Schema.Types.Mixed, default: {} },
    architecture: { type: mongoose.Schema.Types.Mixed, default: {} },
    bom: { type: mongoose.Schema.Types.Mixed, default: {} },
    eda_data: { type: mongoose.Schema.Types.Mixed, default: {} },
    pcb_ir: { type: mongoose.Schema.Types.Mixed, default: {} },
    validation: { type: mongoose.Schema.Types.Mixed, default: {} },
    documentation: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Stats
    stats: {
      chats: { type: Number, default: 0 },
      files: { type: Number, default: 0 },
      documents: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

// Text index for search
projectSchema.index({ title: 'text', description: 'text', tags: 'text' });

export const Project = mongoose.model('Project', projectSchema);
