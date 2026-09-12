import mongoose, { Schema, Document } from "mongoose";
import { Quality, FileType } from "../../types";

export interface IJobFile extends Document {
  _id: mongoose.Types.ObjectId;
  jobId: string;
  userId: mongoose.Types.ObjectId;
  url: string;
  fileName: string;
  quality: Quality;
  fileType: FileType;
  mimeType: string;
  fileSize?: number;
  downloaded: boolean;
  failed: boolean;
  retries: number;
  maxRetries: number;
  error?: string;
  storageKey?: string;
  selected: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const JobFileSchema = new Schema<IJobFile>(
  {
    jobId: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    url: { type: String, required: true },
    fileName: { type: String, required: true },
    quality: { type: String, enum: ["360p", "480p", "720p", "1080p"], required: true },
    fileType: {
      type: String,
      enum: ["video", "audio", "image", "document", "archive", "other"],
      required: true,
    },
    mimeType: { type: String, required: true },
    fileSize: { type: Number },
    downloaded: { type: Boolean, default: false },
    failed: { type: Boolean, default: false },
    retries: { type: Number, default: 0 },
    maxRetries: { type: Number, default: 3 },
    error: { type: String },
    storageKey: { type: String },
    selected: { type: Boolean, default: true },
  },
  { timestamps: true }
);

JobFileSchema.index({ jobId: 1 });
JobFileSchema.index({ jobId: 1, downloaded: 1 });
JobFileSchema.index({ userId: 1 });

export const JobFile =
  mongoose.models.JobFile || mongoose.model<IJobFile>("JobFile", JobFileSchema);
