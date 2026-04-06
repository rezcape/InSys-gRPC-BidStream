import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { catalogHandlers } from './catalog.handler';
import { CATALOG_SERVICE_PORT } from '../shared/types';

const PROTO_PATH = path.join(__dirname, '../../proto/catalog.proto');

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const proto = grpc.loadPackageDefinition(packageDef) as any;
const server = new grpc.Server();
server.addService(proto.catalog.CatalogService.service, catalogHandlers);

server.bindAsync(
  `0.0.0.0:${CATALOG_SERVICE_PORT}`,
  grpc.ServerCredentials.createInsecure(),
  (err, port) => {
    if (err) throw err;
    console.log(`📋 Catalog Service running on port ${port}`);
  }
);
