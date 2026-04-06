import * as grpc from '@grpc/grpc-js';
import { verifyToken } from '../../shared/utils/jwt.utils';

export function jwtInterceptor(
  methodDescriptor: any,
  nextCall: any
): grpc.InterceptingCall {
  return new grpc.InterceptingCall(nextCall(methodDescriptor), {
    start: (metadata, listener, next) => {
      const token = metadata.get('authorization')[0] as string;

      if (!token) {
        const err = {
          code: grpc.status.UNAUTHENTICATED,
          message: 'No token provided',
        };
        listener.onReceiveStatus(err as any);
        return;
      }

      try {
        const payload = verifyToken(token.replace('Bearer ', ''));
        metadata.set('x-user-id', payload.userId);
        metadata.set('x-username', payload.username);
        next(metadata, listener);
      } catch {
        const err = {
          code: grpc.status.UNAUTHENTICATED,
          message: 'Invalid or expired token',
        };
        listener.onReceiveStatus(err as any);
      }
    },
  });
}
