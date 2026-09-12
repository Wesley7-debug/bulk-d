import mongoose, { Schema, Document } from "mongoose";

export interface IMagicLink extends Document {
  _id: mongoose.Types.ObjectId;
  email: string;
  token: string;
  expiresAt: Date;
  used: boolean;
  createdAt: Date;
}

const MagicLinkSchema = new Schema<IMagicLink>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    token: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    used: { type: Boolean, default: false },
  },
  { timestamps: true }
);

MagicLinkSchema.index({ token: 1 });
MagicLinkSchema.index({ email: 1, expiresAt: 1 });

export const MagicLink =
  mongoose.models.MagicLink ||
  mongoose.model<IMagicLink>("MagicLink", MagicLinkSchema);
