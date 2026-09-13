import mongoose, { Schema, Document } from "mongoose";
import { JobStatus, Quality } from "../../types";

export interface IJob extends Document {
  _id: mongoose.Types.ObjectId;
  jobId: string;
  userId: mongoose.Types.ObjectId;
  sourceUrl: string;
  collectionTitle: string;
  quality: Quality;
  thumbnailUrl?: string;
  status: JobStatus;
  totalFiles: number;
  completedFiles: number;
  failedFiles: number;
  totalBytes: number;
  downloadedBytes: number;
  zipKey?: string;
  zipUrl?: string;
  zipSize?: number;
  zipExpiresAt?: Date;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

const JobSchema = new Schema<IJob>(
  {
    jobId: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    sourceUrl: { type: String, required: true },
    collectionTitle: { type: String, required: true },
    quality: { type: String, required: true },
    thumbnailUrl: { type: String },
    status: {
      type: String,
      enum: [
        "analyzing",
        "queued",
        "downloading",
        "packaging",
        "completed",
        "failed",
        "partial",
        "cancelled",
      ],
      default: "analyzing",
      required: true,
    },
    totalFiles: { type: Number, default: 0 },
    completedFiles: { type: Number, default: 0 },
    failedFiles: { type: Number, default: 0 },
    totalBytes: { type: Number, default: 0 },
    downloadedBytes: { type: Number, default: 0 },
    zipKey: { type: String },
    zipUrl: { type: String },
    zipSize: { type: Number },
    zipExpiresAt: { type: Date },
    error: { type: String },
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

JobSchema.index({ userId: 1, createdAt: -1 });
JobSchema.index({ jobId: 1 });
JobSchema.index({ status: 1 });
JobSchema.index({ zipExpiresAt: 1 }, { expireAfterSeconds: 0 });

export const Job = mongoose.models.Job || mongoose.model<IJob>("Job", JobSchema);
