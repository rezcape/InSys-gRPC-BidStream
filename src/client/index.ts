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

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (input) => resolve(input)));
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

async function monitorAuction(auctionId: string, token: string): Promise<void> {
  console.log(`\n[Monitor] Watching auction ${auctionId}...`);

  const printLeaderboard = async () => {
    try {
      const board = await unary<any, any>(
        biddingClient.GetLeaderboard.bind(biddingClient),
        { auction_id: auctionId, limit: 3 }
      );

      const entries = board?.entries ?? [];
      if (entries.length === 0) return;

      console.log('[Leaderboard Top 3]');
      entries.forEach((entry: any) => {
        console.log(`  #${entry.rank} ${entry.bidder_name} - Rp${Number(entry.highest_bid).toLocaleString()}`);
      });
    } catch {
      // Ignore transient errors while monitor stream is active
    }
  };

  await new Promise<void>((resolve, reject) => {
    const stream = biddingClient.SendUpdate({ auction_id: auctionId, token });

    stream.on('data', async (update: any) => {
      printBidUpdate(update, true);

      if (update.event_type === 'BID_UPDATE') {
        await printLeaderboard();
      }

      if (update.event_type === 'AUCTION_CLOSED' || Number(update.remaining_seconds ?? 0) <= 0) {
        try {
          const result = await unary<any, any>(biddingClient.GetAuctionResult.bind(biddingClient), {
            auction_id: auctionId,
          });

          console.log(`\n[Result] Winner: ${result.winner || '-'} | Final Price: Rp${Number(result.final_price).toLocaleString()}`);
          console.log(`[Result] Auction closed: ${result.auction_closed}`);
          await printLeaderboard();
        } catch (err: any) {
          console.error('[Result Error]', err.message);
        }

        stream.cancel();
        resolve();
      }
    });

    stream.on('error', (err: any) => {
      if (err?.code === grpc.status.CANCELLED) {
        return;
      }
      console.error('[Monitor Error]', err.message);
      reject(err);
    });
  });
}

async function bidderSession(auctionId: string, bidderName: string, token: string): Promise<void> {
  try {
    const auctionInfo = await unary<any, any>(
      catalogClient.GetAuctionInfo.bind(catalogClient),
      { auction_id: auctionId }
    );

    console.log('\n[Auction Info]');
    console.log(`  Auction ID : ${auctionInfo.auction_id}`);
    console.log(`  Item       : ${auctionInfo.item_name} (${auctionInfo.item_id})`);
    console.log(`  Start Price: Rp${Number(auctionInfo.starting_price).toLocaleString()}`);
    console.log(`  Status     : ${auctionInfo.is_open ? 'OPEN' : 'CLOSED'}`);
  } catch (err: any) {
    console.error(`[Auction Info Error] ${err.message}`);
    return;
  }

  const selectedToken = process.env.TOKEN ?? await (async () => {
    const tokenPrompt = createPrompt();
    const input = (await ask(tokenPrompt, '\nMasukkan token (Enter = token login otomatis): ')).trim();
    tokenPrompt.close();
    return input || token;
  })();

  const validateAccess = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const stream = biddingClient.SendUpdate({ auction_id: auctionId, token: selectedToken });
      let validated = false;

      const timer = setTimeout(() => {
        stream.cancel();
        reject(new Error('Sesi auction tidak tersedia atau koneksi timeout'));
      }, 4000);

      stream.on('data', () => {
        validated = true;
        clearTimeout(timer);
        stream.cancel();
        resolve();
      });

      stream.on('error', (err: any) => {
        clearTimeout(timer);
        if (validated && err?.code === grpc.status.CANCELLED) {
          return;
        }
        reject(err);
      });
    });
  };

  try {
    await validateAccess();
  } catch (err: any) {
    console.error(`\n[Access Denied] ${err.message}`);
    console.log('[Access Denied] Token atau auction tidak valid. Sesi bidding ditutup.');
    return;
  }

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

  stream.on('error', (err: any) => {
    console.error('[Stream Error]', err.message);
    auctionClosed = true;
    rl.close();
  });

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
        token: selectedToken,
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
    if (BIDDER_NAME.toLowerCase() === 'admin') {
      const rl = createPrompt();

      while (true) {
        const refreshedItemsRes = await unary<any, any>(catalogClient.GetItems.bind(catalogClient), {});
        const availableItems = refreshedItemsRes?.items ?? [];

        console.log('\n[Admin Menu]');
        console.log('  1. Mulai sesi lelang');
        console.log('  2. Tambah barang lelang');
        console.log('  3. Reset item sold (by item_id)');
        console.log('  q. keluar');

        const action = (await ask(rl, '\nPilih menu: ')).trim().toLowerCase();
        if (action === 'q') {
          console.log('[Admin] Exit admin monitor');
          rl.close();
          return;
        }

        if (action === '2') {
          const name = (await ask(rl, 'Nama barang: ')).trim();
          const description = (await ask(rl, 'Deskripsi barang: ')).trim();
          const startingPriceInput = (await ask(rl, 'Starting price (angka): ')).trim();
          const startingPrice = Number(startingPriceInput);

          if (!name) {
            console.log('[Admin] Nama barang wajib diisi.');
            continue;
          }

          if (!Number.isFinite(startingPrice) || startingPrice <= 0) {
            console.log('[Admin] Starting price harus angka positif.');
            continue;
          }

          try {
            const addRes = await unary<any, any>(
              catalogClient.AddItem.bind(catalogClient),
              {
                name,
                description,
                starting_price: startingPrice,
              }
            );

            console.log(`[Admin] Barang berhasil ditambahkan: ${addRes.item_id}`);
          } catch (err: any) {
            console.error(`[Admin] Gagal menambah barang: ${err.message}`);
          }
          continue;
        }

        if (action === '3') {
          const itemId = (await ask(rl, 'Masukkan item_id yang mau di-reset: ')).trim();
          if (!itemId) {
            console.log('[Admin] item_id wajib diisi.');
            continue;
          }

          try {
            const resetRes = await unary<any, any>(
              catalogClient.ResetItem.bind(catalogClient),
              { item_id: itemId }
            );
            console.log(`[Admin] ${resetRes.message}`);
          } catch (err: any) {
            console.error(`[Admin] Gagal reset item: ${err.message}`);
          }
          continue;
        }

        if (action !== '1') {
          console.log('[Admin] Menu tidak dikenal. Pilih 1, 2, 3, atau q.');
          continue;
        }

        if (availableItems.length === 0) {
          console.log('\n[Admin] Tidak ada item yang tersedia. Tambah barang dulu.');
          continue;
        }

        console.log('\n[Admin] Pilih item untuk dibuka:');
        availableItems.forEach((item: any, index: number) => {
          console.log(`  ${index + 1}. ${item.name} [${item.id}] (Rp${Number(item.starting_price).toLocaleString()})`);
        });

        const itemInput = (await ask(rl, '\nMasukkan nomor item: ')).trim();
        const parsedIndex = Number(itemInput);
        const selectedIndex = Number.isFinite(parsedIndex) ? parsedIndex - 1 : -1;

        if (selectedIndex < 0) {
          console.log('[Admin] Nomor item tidak valid.');
          continue;
        }

        const selected = availableItems[Math.max(0, Math.min(selectedIndex, availableItems.length - 1))];
        const openAuctionRes = await unary<any, any>(
          catalogClient.OpenAuction.bind(catalogClient),
          { item_id: selected.id, duration_seconds: 180 }
        );

        console.log(`\n[Catalog] Opened auction ${openAuctionRes.auction_id} for ${selected.name}`);
        console.log(`[Catalog] Share AUCTION=${openAuctionRes.auction_id} to other bidders`);

        await monitorAuction(openAuctionRes.auction_id, loginRes.token);
        console.log('\n[Admin] Sesi selesai. Kamu bisa pilih item lain.');
      }
    }

    console.log('\n💡 Tip: Set AUCTION=<auction_id> env var to join a live auction');
    console.log('💡 Run admin to open an auction first: BIDDER=Admin npm run client');
    return;
  }

  await bidderSession(AUCTION_ID, BIDDER_NAME, loginRes.token);
}

main().catch(console.error);
