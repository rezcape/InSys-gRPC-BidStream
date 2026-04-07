import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { AuctionRoom, BIDDING_SERVICE_PORT } from '../shared/types';

const BIDDING_PROTO_PATH = path.join(__dirname, '../../proto/bidding.proto');
const biddingPackageDef = protoLoader.loadSync(BIDDING_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const biddingProto = grpc.loadPackageDefinition(biddingPackageDef) as any;
const biddingClient = new biddingProto.bidding.BiddingService(
  `localhost:${BIDDING_SERVICE_PORT}`,
  grpc.credentials.createInsecure()
);

// In-memory item database (seed data)
const itemDatabase = new Map([
  ['item-001', { id: 'item-001', name: 'Lukisan Raden Saleh', description: 'Karya asli abad ke-19', starting_price: 500000000 }],
  ['item-002', { id: 'item-002', name: 'Jam Tangan Vintage Rolex', description: 'Seri 1965, kondisi prima', starting_price: 150000000 }],
  ['item-003', { id: 'item-003', name: 'Koin Kuno Majapahit', description: 'Koleksi langka', starting_price: 75000000 }],
]);

// Active auction rooms
export const auctionRooms = new Map<string, AuctionRoom>();
const soldItemIds = new Set<string>();
const GRACE_PERIOD_MS = 2000;

// Subscribers for MonitorAuctionFeed
const feedSubscribers: grpc.ServerWritableStream<any, any>[] = [];

function isItemInOpenAuction(itemId: string): boolean {
  return Array.from(auctionRooms.values()).some((room) => room.itemId === itemId && room.isOpen);
}

export const catalogHandlers = {
  GetItems: (call: any, callback: any) => {
    const items = Array.from(itemDatabase.values()).filter(
      (item: any) => !soldItemIds.has(item.id) && !isItemInOpenAuction(item.id)
    );
    console.log(`[Catalog] GetItems — returning ${items.length} items`);
    callback(null, { items });
  },

  AddItem: (call: any, callback: any) => {
    const { name, description, starting_price } = call.request;

    if (!name || !String(name).trim()) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'name is required',
      });
    }

    const price = Number(starting_price);
    if (!Number.isFinite(price) || price <= 0) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'starting_price must be a positive number',
      });
    }

    const itemId = `item-${uuidv4().slice(0, 8)}`;
    itemDatabase.set(itemId, {
      id: itemId,
      name: String(name).trim(),
      description: String(description || '').trim(),
      starting_price: price,
    });

    console.log(`[Catalog] New item added: ${itemId} (${name})`);
    callback(null, {
      success: true,
      item_id: itemId,
      message: 'Item added successfully',
    });
  },

  ResetItem: (call: any, callback: any) => {
    const { item_id } = call.request;

    if (!item_id) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'item_id is required',
      });
    }

    if (!itemDatabase.has(item_id)) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: `Item ${item_id} not found`,
      });
    }

    if (isItemInOpenAuction(item_id)) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Item ${item_id} is currently in an active auction`,
      });
    }

    soldItemIds.delete(item_id);
    callback(null, {
      success: true,
      message: `Item ${item_id} reset and available for auction`,
    });
  },

  OpenAuction: (call: any, callback: any) => {
    const { item_id, duration_seconds } = call.request;
    const item = itemDatabase.get(item_id);

    if (!item) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: `Item ${item_id} not found`,
      });
    }

    if (soldItemIds.has(item_id)) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Item ${item_id} already sold`,
      });
    }

    if (isItemInOpenAuction(item_id)) {
      return callback({
        code: grpc.status.FAILED_PRECONDITION,
        message: `Item ${item_id} is currently in an active auction`,
      });
    }

    const auctionId = uuidv4();
    const room: AuctionRoom = {
      auctionId,
      itemId: item_id,
      itemName: item.name,
      startingPrice: item.starting_price,
      durationSeconds: duration_seconds || 180,
      openedAt: new Date(),
      isOpen: true,
    };

    auctionRooms.set(auctionId, room);

    biddingClient.CreateAuctionRoom(
      {
        auction_id: auctionId,
        starting_price: room.startingPrice,
        duration_seconds: room.durationSeconds,
      },
      (err: any) => {
        if (err) {
          console.error(`[Catalog] Failed to initialize bidding room for ${auctionId}: ${err.message}`);
          auctionRooms.delete(auctionId);
          return callback({
            code: grpc.status.INTERNAL,
            message: `Failed to initialize bidding room for ${auctionId}`,
          });
        }
        console.log(`[Catalog] Auction opened: ${auctionId} for ${item.name}`);

        // Broadcast to all feed subscribers
        const event = {
          auction_id: auctionId,
          item_id: room.itemId,
          item_name: room.itemName,
          starting_price: room.startingPrice,
          duration_seconds: room.durationSeconds,
          event_type: 'AUCTION_OPENED',
        };

        feedSubscribers.forEach((sub) => {
          try { sub.write(event); } catch { /* subscriber disconnected */ }
        });

        // Start grace closing after duration
        setTimeout(() => {
          room.isOpen = false;
          console.log(`[Catalog] Auction entering grace close: ${auctionId}`);

          feedSubscribers.forEach((sub) => {
            try { sub.write({ ...event, event_type: 'AUCTION_CLOSING' }); } catch {}
          });

          setTimeout(() => {
            soldItemIds.add(room.itemId);
            console.log(`[Catalog] Auction closed: ${auctionId}`);

            biddingClient.CloseAuctionRoom({ auction_id: auctionId }, (closeErr: any) => {
              if (closeErr) {
                console.error(`[Catalog] Failed to close bidding room for ${auctionId}: ${closeErr.message}`);
              }
            });

            feedSubscribers.forEach((sub) => {
              try { sub.write({ ...event, event_type: 'AUCTION_CLOSED' }); } catch {}
            });
          }, GRACE_PERIOD_MS);
        }, room.durationSeconds * 1000);

        callback(null, { success: true, auction_id: auctionId, message: 'Auction opened' });
      }
    );
  },

  GetAuctionInfo: (call: any, callback: any) => {
    const { auction_id } = call.request;

    if (!auction_id) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'auction_id is required',
      });
    }

    const room = auctionRooms.get(auction_id);
    if (!room) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: `Auction ${auction_id} not found`,
      });
    }

    const item = itemDatabase.get(room.itemId);
    callback(null, {
      auction_id: room.auctionId,
      item_id: room.itemId,
      item_name: room.itemName,
      item_description: item?.description || '',
      starting_price: room.startingPrice,
      is_open: room.isOpen,
    });
  },

  MonitorAuctionFeed: (call: grpc.ServerWritableStream<any, any>) => {
    console.log(`[Catalog] New feed subscriber`);
    feedSubscribers.push(call);

    call.on('cancelled', () => {
      const idx = feedSubscribers.indexOf(call);
      if (idx !== -1) feedSubscribers.splice(idx, 1);
      console.log(`[Catalog] Feed subscriber disconnected`);
    });
  },
};
