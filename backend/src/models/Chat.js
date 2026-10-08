import mongoose from 'mongoose';

const chatSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, default: 'New chat', maxlength: 160, trim: true },
    pinned: { type: Boolean, default: false },
    messageCount: { type: Number, default: 0 },
    lastMessageAt: { type: Date, default: Date.now },

    // Server-only monthly entitlement. Kept on the chat so deleting a chat
    // never resets the account's monthly counter or transfers its allowance.
    freeDesign: {
      period: String,
      pendingJobId: String,
      completedActions: { type: [String], default: undefined },
      successfulRequests: Number,
    },

    // Pipeline artifacts, scoped to THIS chat session rather than the project
    // it belongs to — a project can hold several independent conversations
    // (see chatRoutes), each exploring its own requirements/architecture/etc,
    // and mirroring them onto the shared Project would make every session
    // overwrite every other session's design. Field set mirrors Project.js.
    requirements: { type: mongoose.Schema.Types.Mixed, default: {} },
    architecture: { type: mongoose.Schema.Types.Mixed, default: {} },
    bom: { type: mongoose.Schema.Types.Mixed, default: {} },
    eda_data: { type: mongoose.Schema.Types.Mixed, default: {} },
    pcb_ir: { type: mongoose.Schema.Types.Mixed, default: {} },
    validation: { type: mongoose.Schema.Types.Mixed, default: {} },
    handoff_validation: { type: mongoose.Schema.Types.Mixed, default: {} },
    documentation: { type: mongoose.Schema.Types.Mixed, default: {} },
    code_generation: { type: mongoose.Schema.Types.Mixed, default: {} },
    // The generated board (dunkai-designer output) — see Project.js's own
    // `board` field for why this one is stored rather than re-derived.
    board: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

export const Chat = mongoose.model('Chat', chatSchema);
