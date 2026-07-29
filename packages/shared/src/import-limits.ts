/**
 * Bounded loose-file upload contract shared by the loopback API and browser.
 * Larger exports use path import so neither side has to retain a huge base64
 * request in memory.
 */
export interface ImportUploadLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalDecodedBytes: number;
  maxBodyBytes: number;
  maxNameLength: number;
  maxIdLength: number;
}

export const DEFAULT_IMPORT_UPLOAD_LIMITS: Readonly<ImportUploadLimits> = {
  maxFiles: 128,
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalDecodedBytes: 64 * 1024 * 1024,
  maxBodyBytes: 88 * 1024 * 1024,
  maxNameLength: 255,
  maxIdLength: 64,
};
