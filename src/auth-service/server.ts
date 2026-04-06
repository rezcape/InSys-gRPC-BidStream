import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { authHandlers } from './auth.handler';
import { AUTH_SERVICE_PORT } from '../shared/types';

const PROTO_PATH = path.join(__dirname, '../../proto/auth.proto');

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const proto = grpc.loadPackageDefinition(packageDef) as any;

const server = new grpc.Server();
server.addService(proto.auth.AuthService.service, authHandlers);

server.bindAsync(
  `0.0.0.0:${AUTH_SERVICE_PORT}`,
  grpc.ServerCredentials.createInsecure(),
  (err, port) => {
    if (err) throw err;
    console.log(`🔐 Auth Service running on port ${port}`);
  }
);
