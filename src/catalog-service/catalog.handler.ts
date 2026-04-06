import * as grpc from '@grpc/grpc-js';
import { v4 as uuidv4 } from 'uuid';
import { AuctionRoom } from '../shared/types';

// In-memory item database (seed data)
const itemDatabase = new Map([
  ['item-001', { id: 'item-001', name: 'Lukisan Raden Saleh', description: 'Karya asli abad ke-19', starting_price: 500000000 }],
  ['item-002', { id: 'item-002', name: 'Jam Tangan Vintage Rolex', description: 'Seri 1965, kondisi prima', starting_price: 150000000 }],
  ['item-003', { id: 'item-003', name: 'Koin Kuno Majapahit', description: 'Koleksi langka', starting_price: 75000000 }],
]);

// Active auction rooms
export const auctionRooms = new Map<string, AuctionRoom>();

// Subscribers for MonitorAuctionFeed
const feedSubscribers: grpc.ServerWritableStream<any, any>[] = [];

export const catalogHandlers = {
  GetItems: (call: any, callback: any) => {
    const items = Array.from(itemDatabase.values());
    console.log(`[Catalog] GetItems — returning ${items.length} items`);
    callback(null, { items });
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

    const auctionId = uuidv4();
    const room: AuctionRoom = {
      auctionId,
      itemId: item_id,
      itemName: item.name,
      startingPrice: item.starting_price,
      durationSeconds: duration_seconds || 60,
      openedAt: new Date(),
      isOpen: true,
    };

    auctionRooms.set(auctionId, room);
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

    // Auto-close after duration
    setTimeout(() => {
      room.isOpen = false;
      console.log(`[Catalog] Auction closed: ${auctionId}`);
      feedSubscribers.forEach((sub) => {
        try { sub.write({ ...event, event_type: 'AUCTION_CLOSED' }); } catch {}
      });
    }, room.durationSeconds * 1000);

    callback(null, { success: true, auction_id: auctionId, message: 'Auction opened' });
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
