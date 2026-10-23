import jwt from 'jsonwebtoken';

/** Require a valid, unexpired admin session signed with the configured secret. */
export default function adminAuth(req, res, next) {
  const authorization = req.headers.authorization || '';
  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ success: false, code: 'ADMIN_AUTH_REQUIRED', message: 'Admin authentication required.' });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return res.status(503).json({ success: false, code: 'AUTH_UNAVAILABLE', message: 'Authentication is not configured.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.isAdmin !== true || !decoded.id) {
      return res.status(403).json({ success: false, code: 'ADMIN_ACCESS_REQUIRED', message: 'Administrator access required.' });
    }
    decoded.role = 'admin';
    req.user = decoded;
    return next();
  } catch (_error) {
    return res.status(401).json({ success: false, code: 'ADMIN_TOKEN_INVALID', message: 'Admin session is invalid or expired.' });
  }
}
