export const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/bulkforge";
export const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
export const S3_ENDPOINT = process.env.S3_ENDPOINT || "";
export const S3_BUCKET = process.env.S3_BUCKET || "bulkforge";
export const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || "";
export const S3_SECRET_KEY = process.env.S3_SECRET_KEY || "";
export const S3_REGION = process.env.S3_REGION || "us-east-1";

export const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || "5");
export const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || "2048");
export const ZIP_EXPIRY_HOURS = parseInt(process.env.ZIP_EXPIRY_HOURS || "72");
export const MAX_FILES_PER_JOB = parseInt(process.env.MAX_FILES_PER_JOB || "200");

export const CRAWL_MAX_DEPTH = parseInt(process.env.CRAWL_MAX_DEPTH || "3");
export const CRAWL_MAX_PAGES = parseInt(process.env.CRAWL_MAX_PAGES || "50");
export const CRAWL_TIMEOUT_MS = parseInt(process.env.CRAWL_TIMEOUT_MS || "30000");
export const CRAWL_CONCURRENCY = parseInt(process.env.CRAWL_CONCURRENCY || "5");

export const GOOGLE_SEARCH_API_KEY = process.env.GOOGLE_SEARCH_API_KEY || "";
export const GOOGLE_SEARCH_ENGINE_ID = process.env.GOOGLE_SEARCH_ENGINE_ID || "";

export const JOB_STATES = {
  ANALYZING: "analyzing",
  DISCOVERED: "discovered",
  READY: "ready",
  QUEUED: "queued",
  DOWNLOADING: "downloading",
  PACKAGING: "packaging",
  COMPLETED: "completed",
  FAILED: "failed",
  PARTIAL: "partial",
  CANCELLED: "cancelled",
} as const;

export const QUALITIES = ["360p", "480p", "720p", "1080p"] as const;

export const ALLOWED_DOMAINS = process.env.ALLOWED_DOMAINS?.split(",") || [];

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const REQUEST_TIMEOUT_MS = 30000;
export const MAX_REDIRECTS = 5;

export const MEDIA_EXTENSIONS: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mov: "video/quicktime",
  flv: "video/x-flv",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  tar: "application/x-tar",
  gz: "application/gzip",
};

export const VIDEO_EXTENSIONS = ["mp4", "webm", "mkv", "avi", "mov", "flv"];
export const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "flac", "m4a", "aac"];
export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "svg"];
export const DOCUMENT_EXTENSIONS = ["pdf", "doc", "docx", "txt"];
export const ARCHIVE_EXTENSIONS = ["zip", "rar", "7z", "tar", "gz"];

export const BLOCKED_MIME_TYPES = new Set([
  "text/html",
  "text/css",
  "application/javascript",
  "text/javascript",
  "application/x-shockwave-flash",
]);

export const BLOCKED_EXTENSIONS = new Set(["exe", "bat", "cmd", "sh", "ps1", "msi", "dll"]);

export const DRM_PATTERNS = [
  /drm/i,
  /widevine/i,
  /playready/i,
  /fairplay/i,
  /encrypted/i,
  /license/i,
  /token.*expire/i,
];

export const SERIES_PATTERNS = [
  /season[\s._-]?\d+/i,
  /episode[\s._-]?\d+/i,
  /ep[\s._-]?\d+/i,
  /s\d+e\d+/i,
  /part[\s._-]?\d+/i,
  /vol(?:ume)?[\s._-]?\d+/i,
  /chapter[\s._-]?\d+/i,
];

export const KNOWN_FILE_HOSTS = [
  "loadedfiles.org",
  "mediafire.com",
  "mega.nz",
  "mega.co.nz",
  "drive.google.com",
  "dropbox.com",
  "onedrive.live.com",
  "sendspace.com",
  "zippyshare.com",
  "1fichier.com",
  "uptobox.com",
  "nitroflare.com",
  "rapidgator.net",
  "uploaded.net",
  "filefactory.com",
  "tusfiles.com",
  "userscloud.com",
  "torchshare.net",
  "file-upload.com",
  "dl-protect.com",
];

export const FILE_HOST_EXTENSIONS = new Set([
  "mkv", "mp4", "avi", "mov", "wmv", "flv", "webm",
  "mp3", "wav", "flac", "aac", "ogg", "m4a",
  "zip", "rar", "7z", "tar", "gz",
  "pdf", "doc", "docx",
]);
