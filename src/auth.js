import jwt from 'jsonwebtoken';

export function signUser(user) {
  return jwt.sign(user, getSecret(), { expiresIn: '7d' });
}

export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }

  try {
    req.user = jwt.verify(token, getSecret());
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid session' });
  }
}

export function adminRequired(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function getSecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }
  return process.env.JWT_SECRET;
}
