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
import readline from 'readline';
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

function createPrompt() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function unary<TReq, TRes>(
  fn: (req: TReq, cb: (err: any, res: TRes) => void) => void,
  req: TReq
): Promise<TRes> {
  return new Promise<TRes>((resolve, reject) => {
    fn(req, (err: any, res: TRes) => {
      if (err) return reject(err);
      resolve(res);
    });
  });
}

function printBidUpdate(update: any, showTimer: boolean) {
  const remaining = Number(update.remaining_seconds ?? 0);
  const highestBidder = update.highest_bidder || '-';
  const highestAmount = Number(update.highest_amount ?? 0);
  const eventType = update.event_type || 'UPDATE';

  if (showTimer) {
    console.log(`\n[${eventType}] Timer: ${remaining}s | Highest: ${highestBidder} @ Rp${highestAmount.toLocaleString()}`);
    return;
  }

  if (eventType === 'TIMER_TICK') return;

  if (eventType === 'SNAPSHOT') {
    console.log(`\n[Auction] Highest sekarang: ${highestBidder} @ Rp${highestAmount.toLocaleString()}`);
    return;
  }

  if (eventType === 'BID_UPDATE') {
    console.log(`\n[Bid Accepted] ${highestBidder} @ Rp${highestAmount.toLocaleString()}`);
    return;
  }

  if (eventType === 'BID_REJECTED') {
    console.log(`\n[Bid Rejected] Bid kamu belum cukup. Highest saat ini: Rp${highestAmount.toLocaleString()}`);
    return;
  }

  if (eventType === 'AUCTION_CLOSED') {
    console.log(`\n[Auction Closed] Final highest: ${highestBidder} @ Rp${highestAmount.toLocaleString()}`);
    return;
  }

  console.log(`\n[${eventType}] Highest: ${highestBidder} @ Rp${highestAmount.toLocaleString()}`);
}

async function monitorAuction(auctionId: string): Promise<void> {
  console.log(`\n[Monitor] Watching auction ${auctionId}...`);

  await new Promise<void>((resolve, reject) => {
    const stream = biddingClient.SendUpdate({ auction_id: auctionId });

    stream.on('data', async (update: any) => {
      printBidUpdate(update, true);

      if (update.event_type === 'AUCTION_CLOSED' || Number(update.remaining_seconds ?? 0) <= 0) {
        try {
          const result = await unary<any, any>(biddingClient.GetAuctionResult.bind(biddingClient), {
            auction_id: auctionId,
          });

          console.log(`\n[Result] Winner: ${result.winner || '-'} | Final Price: Rp${Number(result.final_price).toLocaleString()}`);
          console.log(`[Result] Auction closed: ${result.auction_closed}`);
        } catch (err: any) {
          console.error('[Result Error]', err.message);
        }

        stream.cancel();
        resolve();
      }
    });

    stream.on('error', (err: any) => {
      console.error('[Monitor Error]', err.message);
      reject(err);
    });
  });
}

async function bidderSession(auctionId: string, bidderName: string, token: string): Promise<void> {
  console.log(`\n[Bidding] Joining auction ${auctionId}...`);
  const stream = biddingClient.LiveBidding();
  const rl = createPrompt();
  let auctionClosed = false;

  stream.on('data', (update: any) => {
    printBidUpdate(update, false);

    if (update.event_type === 'AUCTION_CLOSED' || Number(update.remaining_seconds ?? 0) <= 0) {
      auctionClosed = true;
      console.log('\n[Auction] Closed. Input disabled.');
      rl.close();
      stream.end();
    }
  });

  stream.on('error', (err: any) => console.error('[Stream Error]', err.message));

  const askBid = () => {
    if (auctionClosed) return;

    rl.question('\nMasukkan nominal bid (angka) atau ketik q untuk keluar: ', (input) => {
      const trimmed = input.trim();

      if (trimmed.toLowerCase() === 'q') {
        console.log('[Client] Exit bidding session');
        rl.close();
        stream.end();
        return;
      }

      const amount = Number(trimmed);
      if (!Number.isFinite(amount) || amount <= 0) {
        console.log('[Client] Nominal tidak valid. Contoh: 550000000');
        askBid();
        return;
      }

      stream.write({
        auction_id: auctionId,
        bidder_name: bidderName,
        amount,
        token,
      });

      askBid();
    });
  };

  askBid();
}

async function main() {
  console.log(`\n🎯 BidStream Client — ${BIDDER_NAME}\n`);

  // 1. Register & Login
  const registerRes = await unary<any, any>(
    authClient.Register.bind(authClient),
    { username: BIDDER_NAME, password: 'pass123' }
  );
  console.log(`[Auth] ${registerRes.message}`);

  const loginRes = await unary<any, any>(
    authClient.Login.bind(authClient),
    { username: BIDDER_NAME, password: 'pass123' }
  );
  console.log(`[Auth] Token: ${loginRes.token.substring(0, 20)}...`);

  // 2. Get items
  const itemsRes = await unary<any, any>(catalogClient.GetItems.bind(catalogClient), {});
  console.log(`\n[Catalog] Available items:`);
  itemsRes?.items?.forEach((item: any) =>
    console.log(`  - ${item.id}: ${item.name} (Rp${Number(item.starting_price).toLocaleString()})`)
  );

  if (!AUCTION_ID) {
    if (BIDDER_NAME.toLowerCase() === 'admin' && itemsRes?.items?.length > 0) {
      const rl = createPrompt();

      const selectedIndex = await new Promise<number>((resolve) => {
        console.log('\n[Admin] Pilih item untuk dibuka:');
        itemsRes.items.forEach((item: any, index: number) => {
          console.log(`  ${index + 1}. ${item.name} (Rp${Number(item.starting_price).toLocaleString()})`);
        });

        rl.question('\nMasukkan nomor item: ', (input) => {
          const parsed = Number(input.trim());
          resolve(Number.isFinite(parsed) ? parsed - 1 : 0);
        });
      });

      rl.close();
      const selected = itemsRes.items[Math.max(0, Math.min(selectedIndex, itemsRes.items.length - 1))];
      const openAuctionRes = await unary<any, any>(
        catalogClient.OpenAuction.bind(catalogClient),
        { item_id: selected.id, duration_seconds: 180 }
      );

      console.log(`\n[Catalog] Opened auction ${openAuctionRes.auction_id} for ${selected.name}`);
      console.log(`[Catalog] Share AUCTION=${openAuctionRes.auction_id} to other bidders`);

      await monitorAuction(openAuctionRes.auction_id);
      return;
    }

    console.log('\n💡 Tip: Set AUCTION=<auction_id> env var to join a live auction');
    console.log('💡 Run admin to open an auction first: BIDDER=Admin npm run client');
    return;
  }

  await bidderSession(AUCTION_ID, BIDDER_NAME, loginRes.token);
}

main().catch(console.error);
