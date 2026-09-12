import mongoose, { Schema, Document } from "mongoose";

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;
  email: string;
  name?: string;
  image?: string;
  provider: "email" | "github" | "google";
  githubId?: string;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date;
  jobCount: number;
  isActive: boolean;
}

const UserSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, trim: true },
    image: { type: String },
    provider: { type: String, enum: ["email", "github", "google"], required: true },
    githubId: { type: String, sparse: true },
    lastLoginAt: { type: Date, default: Date.now },
    jobCount: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

UserSchema.index({ email: 1 });
UserSchema.index({ githubId: 1 }, { sparse: true });

export const User =
  mongoose.models.User || mongoose.model<IUser>("User", UserSchema);
