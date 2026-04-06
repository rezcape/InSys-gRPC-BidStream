import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { biddingHandlers } from './bidding.handler';
import { BIDDING_SERVICE_PORT } from '../shared/types';

const PROTO_PATH = path.join(__dirname, '../../proto/bidding.proto');

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const proto = grpc.loadPackageDefinition(packageDef) as any;
const server = new grpc.Server();
server.addService(proto.bidding.BiddingService.service, biddingHandlers);

server.bindAsync(
  `0.0.0.0:${BIDDING_SERVICE_PORT}`,
  grpc.ServerCredentials.createInsecure(),
  (err, port) => {
    if (err) throw err;
    console.log(`⚡ Bidding Engine running on port ${port}`);
  }
);
