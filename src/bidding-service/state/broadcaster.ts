import * as grpc from '@grpc/grpc-js';
import { BidState } from '../../shared/types';

// Map of auctionId -> list of connected streaming clients
const subscribers = new Map<string, grpc.ServerDuplexStream<any, any>[]>();

export function subscribe(auctionId: string, stream: grpc.ServerDuplexStream<any, any>): void {
  if (!subscribers.has(auctionId)) {
    subscribers.set(auctionId, []);
  }
  subscribers.get(auctionId)!.push(stream);
  console.log(`[Broadcaster] Client joined auction ${auctionId}. Total: ${subscribers.get(auctionId)!.length}`);
}

export function unsubscribe(auctionId: string, stream: grpc.ServerDuplexStream<any, any>): void {
  const subs = subscribers.get(auctionId);
  if (!subs) return;
  const idx = subs.indexOf(stream);
  if (idx !== -1) subs.splice(idx, 1);
  console.log(`[Broadcaster] Client left auction ${auctionId}. Total: ${subs.length}`);
}

export function broadcast(state: BidState): void {
  const subs = subscribers.get(state.auctionId) ?? [];
  const update = {
    auction_id: state.auctionId,
    highest_bidder: state.highestBidder,
    highest_amount: state.highestAmount,
    timestamp: state.timestamp,
  };

  subs.forEach((stream) => {
    try {
      stream.write(update);
    } catch {
      // Client disconnected, will be cleaned up on 'cancelled' event
    }
  });
}
