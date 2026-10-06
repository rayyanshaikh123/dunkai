import mongoose from 'mongoose';

const attachmentSchema = new mongoose.Schema(
  {
    fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'File' },
    name: String,
    url: String,
    mimeType: String,
    size: Number,
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    chat: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true, index: true },
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    type: {
      type: String,
      enum: ['user', 'assistant', 'system', 'agent', 'tool'],
      required: true,
    },
    content: { type: String, required: true },
    clientMessageId: { type: String, maxlength: 120 },
    attachments: [attachmentSchema],
    artifacts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Artifact' }],
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    // For streaming: track if message is complete
    isStreaming: { type: Boolean, default: false },
  },
  { timestamps: true }
);

messageSchema.index({ chat: 1, createdAt: 1 });
messageSchema.index({ chat: 1, clientMessageId: 1 }, { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } });

export const Message = mongoose.model('Message', messageSchema);
