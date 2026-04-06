import * as grpc from '@grpc/grpc-js';
import { placeBid, getCurrentBid, initAuction } from './state/bid.state';
import { subscribe, unsubscribe, broadcast } from './state/broadcaster';

export const biddingHandlers = {
  // Bidirectional Streaming — jantung sistem
  LiveBidding: (call: grpc.ServerDuplexStream<any, any>) => {
    let currentAuctionId: string | null = null;

    call.on('data', async (bidRequest) => {
      const { auction_id, bidder_name, amount } = bidRequest;

      // Subscribe client to this auction on first message
      if (currentAuctionId !== auction_id) {
        if (currentAuctionId) unsubscribe(currentAuctionId, call);
        currentAuctionId = auction_id;
        subscribe(auction_id, call);
      }

      const result = await placeBid(auction_id, bidder_name, amount);

      if (result.success) {
        const state = getCurrentBid(auction_id);
        if (state) broadcast(state); // Push update to all connected clients
      } else {
        // Notify only this client their bid was rejected
        call.write({
          auction_id,
          highest_bidder: '',
          highest_amount: result.currentHighest,
          timestamp: Date.now(),
        });
      }
    });

    call.on('end', () => {
      if (currentAuctionId) unsubscribe(currentAuctionId, call);
      call.end();
    });

    call.on('cancelled', () => {
      if (currentAuctionId) unsubscribe(currentAuctionId, call);
    });

    call.on('error', () => {
      if (currentAuctionId) unsubscribe(currentAuctionId, call);
    });
  },

  // Unary — single bid (fallback / admin use)
  PlaceBid: async (call: any, callback: any) => {
    const { auction_id, bidder_name, amount } = call.request;

    if (!auction_id || !bidder_name || !amount) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'auction_id, bidder_name, and amount are required',
      });
    }

    const result = await placeBid(auction_id, bidder_name, amount);
    callback(null, {
      success: result.success,
      message: result.message,
      current_highest: result.currentHighest,
    });
  },

  // Unary — get final result
  GetAuctionResult: (call: any, callback: any) => {
    const { auction_id } = call.request;
    const state = getCurrentBid(auction_id);

    if (!state) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: `Auction ${auction_id} not found`,
      });
    }

    callback(null, {
      auction_id,
      winner: state.highestBidder || 'No bids',
      final_price: state.highestAmount,
      auction_closed: true,
    });
  },
};

// Export initAuction so catalog service can call this when auction opens
export { initAuction };
