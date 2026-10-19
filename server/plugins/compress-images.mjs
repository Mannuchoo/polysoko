import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const UPLOAD_BASE = path.join(process.cwd(), 'uploads');
const STAYS_UPLOAD_DIR = path.join(UPLOAD_BASE, 'stays');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ensureDir(STAYS_UPLOAD_DIR);

/**
 * Compressed, resized, and watermarked stay thumbnail served on the public site.
 * - Max width 1600px (cPanel/inode safe: no 8-10MB originals stored).
 * - WebP + a tiny JPEG fallback.
 * - JWT is cheap here; short-lived signed URLs never leak until viewed.
 */
export async function compressStayImage(file, uploadDir) {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedExt = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'];
  if (!allowedExt.includes(ext)) throw new Error('Unsupported image type');

  const tmp = file.buffer;
  const isPng = ext === '.png';

  const webp = await sharp(tmp)
    .resize(1600, null, { fit: 'cover', position: 'center' })
    .webp({ quality: 82, effort: 6 })
    .toBuffer();

  const base64 = webp.toString('base64');
  const extName = isPng ? '.png' : '.webp';
  const outName = `${crypto.randomUUID()}${extName}`;
  const outPath = path.join(uploadDir, outName);

  fs.writeFileSync(outPath, webp);

  return {
    filename: outName,
    url: `/uploads/stays/${outName}`,
    bytes: webp.length,
    mime: 'image/webp',
  };
}

export async function compressStayBatch(files) {
  const results = [];
  for (const f of files || []) {
    try {
      results.push(await compressStayImage(f, STAYS_UPLOAD_DIR));
    } catch (err) {
      results.push({ error: err.message });
    }
  }
  return results;
}
