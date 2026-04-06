/**
 * BidStream Demo Client
 * Jalankan beberapa terminal untuk simulasi multi-client
 * 
 * Usage:
 *   BIDDER=Alice AUCTION=<auction_id> ts-node src/client/index.ts
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';
import { AUTH_SERVICE_PORT, CATALOG_SERVICE_PORT, BIDDING_SERVICE_PORT } from '../shared/types';

const load = (file: string) => grpc.loadPackageDefinition(
  protoLoader.loadSync(path.join(__dirname, `../../proto/${file}`), {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  })
) as any;

const authProto    = load('auth.proto');
const catalogProto = load('catalog.proto');
const biddingProto = load('bidding.proto');

const authClient    = new authProto.auth.AuthService(`localhost:${AUTH_SERVICE_PORT}`, grpc.credentials.createInsecure());
const catalogClient = new catalogProto.catalog.CatalogService(`localhost:${CATALOG_SERVICE_PORT}`, grpc.credentials.createInsecure());
const biddingClient = new biddingProto.bidding.BiddingService(`localhost:${BIDDING_SERVICE_PORT}`, grpc.credentials.createInsecure());

const BIDDER_NAME = process.env.BIDDER || 'TestBidder';
const AUCTION_ID  = process.env.AUCTION || '';

async function main() {
  console.log(`\n🎯 BidStream Client — ${BIDDER_NAME}\n`);

  // 1. Register & Login
  const registerRes = await new Promise<any>((res) =>
    authClient.Register({ username: BIDDER_NAME, password: 'pass123' }, (_: any, r: any) => res(r))
  );
  console.log(`[Auth] ${registerRes.message}`);

  const loginRes = await new Promise<any>((res) =>
    authClient.Login({ username: BIDDER_NAME, password: 'pass123' }, (_: any, r: any) => res(r))
  );
  console.log(`[Auth] Token: ${loginRes.token.substring(0, 20)}...`);

  // 2. Get items
  const itemsRes = await new Promise<any>((res) =>
    catalogClient.GetItems({}, (_: any, r: any) => res(r))
  );
  console.log(`\n[Catalog] Available items:`);
  itemsRes?.items?.forEach((item: any) =>
    console.log(`  - ${item.id}: ${item.name} (Rp${Number(item.starting_price).toLocaleString()})`)
  );

  if (!AUCTION_ID) {
    console.log('\n💡 Tip: Set AUCTION=<auction_id> env var to join a live auction');
    console.log('💡 Run admin to open an auction first: BIDDER=Admin ts-node src/client/index.ts');
    return;
  }

  // 3. Join live bidding via bidirectional stream
  console.log(`\n[Bidding] Joining auction ${AUCTION_ID}...`);
  const stream = biddingClient.LiveBidding();

  stream.on('data', (update: any) => {
    console.log(`\n🔔 Update — Highest: ${update.highest_bidder} @ Rp${Number(update.highest_amount).toLocaleString()}`);
  });

  stream.on('error', (err: any) => console.error('[Stream Error]', err.message));

  // Simulate bidding every 3 seconds
  let bidAmount = 10000000;
  const interval = setInterval(() => {
    bidAmount += Math.floor(Math.random() * 5000000) + 1000000;
    console.log(`[Bidding] ${BIDDER_NAME} bidding Rp${bidAmount.toLocaleString()}...`);
    stream.write({ auction_id: AUCTION_ID, bidder_name: BIDDER_NAME, amount: bidAmount });
  }, 3000);

  setTimeout(() => {
    clearInterval(interval);
    stream.end();
    console.log('\n[Client] Done bidding');
  }, 30000);
}

main().catch(console.error);
