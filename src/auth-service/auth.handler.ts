import * as grpc from '@grpc/grpc-js';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
import { User } from '../shared/types';
import { signToken, verifyToken } from '../shared/utils/jwt.utils';

// In-memory user store
const userStore = new Map<string, User>();

function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export const authHandlers = {
  Register: (call: any, callback: any) => {
    const { username, password } = call.request;

    if (userStore.has(username)) {
      return callback(null, {
        success: false,
        token: '',
        message: 'Username already exists',
      });
    }

    const user: User = {
      id: uuidv4(),
      username,
      passwordHash: hashPassword(password),
    };
    userStore.set(username, user);

    const token = signToken({ userId: user.id, username });
    console.log(`[Auth] Registered: ${username}`);
    callback(null, { success: true, token, message: 'Registered successfully' });
  },

  Login: (call: any, callback: any) => {
    const { username, password } = call.request;
    const user = userStore.get(username);

    if (!user || user.passwordHash !== hashPassword(password)) {
      return callback(null, {
        success: false,
        token: '',
        message: 'Invalid credentials',
      });
    }

    const token = signToken({ userId: user.id, username });
    console.log(`[Auth] Login: ${username}`);
    callback(null, { success: true, token, message: 'Login successful' });
  },

  ValidateToken: (call: any, callback: any) => {
    try {
      const { token } = call.request;
      const payload = verifyToken(token);
      callback(null, { valid: true, username: payload.username, user_id: payload.userId });
    } catch {
      callback(null, { valid: false, username: '', user_id: '' });
    }
  },
};
