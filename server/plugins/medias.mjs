import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { compressStayBatch } from './compress-images.mjs';

const STAYS_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'stays');
if (!fs.existsSync(STAYS_UPLOAD_DIR)) fs.mkdirSync(STAYS_UPLOAD_DIR, { recursive: true });

const storage = multer.memoryStorage();
const fileFilter = (req, file, cb) => {
  const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) cb(null, true);
  else cb(new Error('Unsupported image format'), false);
};

export const uploadStays = multer({
  storage,
  fileFilter,
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB per image (before sharp resize)
});

export async function processStayUploads(req, res, next) {
  try {
    const results = await compressStayBatch(req.files);
    const ok = results.filter(r => !r.error).length;
    if (ok === 0) return res.status(400).json({ success: false, message: 'No image could be processed' });
    req.stayUploadResults = results;
    next();
  } catch (err) {
    next(err);
  }
}
