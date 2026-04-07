import * as grpc from '@grpc/grpc-js';
import { BidState } from '../../shared/types';

type SubscriberStream = grpc.ServerDuplexStream<any, any> | grpc.ServerWritableStream<any, any>;

// Map of auctionId -> list of connected streaming clients
const subscribers = new Map<string, SubscriberStream[]>();

export function subscribe(auctionId: string, stream: SubscriberStream): void {
  if (!subscribers.has(auctionId)) {
    subscribers.set(auctionId, []);
  }
  subscribers.get(auctionId)!.push(stream);
  console.log(`[Broadcaster] Client joined auction ${auctionId}. Total: ${subscribers.get(auctionId)!.length}`);
}

export function unsubscribe(auctionId: string, stream: SubscriberStream): void {
  const subs = subscribers.get(auctionId);
  if (!subs) return;
  const idx = subs.indexOf(stream);
  if (idx !== -1) subs.splice(idx, 1);
  console.log(`[Broadcaster] Client left auction ${auctionId}. Total: ${subs.length}`);
}

export function broadcast(state: BidState, remainingSeconds: number, eventType: string = 'BID_UPDATE'): void {
  const subs = subscribers.get(state.auctionId) ?? [];
  const update = {
    auction_id: state.auctionId,
    highest_bidder: state.highestBidder,
    highest_amount: state.highestAmount,
    timestamp: state.timestamp,
    remaining_seconds: remainingSeconds,
    event_type: eventType,
  };

  subs.forEach((stream) => {
    try {
      stream.write(update);
    } catch {
      // Client disconnected, will be cleaned up on 'cancelled' event
    }
  });
}
