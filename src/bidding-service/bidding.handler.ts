import * as grpc from '@grpc/grpc-js';
import { placeBid, getCurrentBid, initAuction } from './state/bid.state';
import { subscribe, unsubscribe, broadcast } from './state/broadcaster';
import { verifyToken } from '../shared/utils/jwt.utils';

export const biddingHandlers = {
  // Bidirectional Streaming — jantung sistem
  LiveBidding: (call: grpc.ServerDuplexStream<any, any>) => {
    let currentAuctionId: string | null = null;

    call.on('data', async (bidRequest) => {
      const { auction_id, bidder_name, amount, token } = bidRequest;

      // Validate token
      if (!token) {
        console.log(`[Bidding] Rejected bid: no token provided`);
        return;
      }

      try {
        const payload = verifyToken(token);
        // Ensure bidder_name matches authenticated user
        if (payload.username !== bidder_name) {
          console.log(`[Bidding] Rejected bid: bidder_name mismatch (${payload.username} != ${bidder_name})`);
          return;
        }
      } catch (err: any) {
        console.log(`[Bidding] Rejected bid: invalid token (${err.message})`);
        return;
      }

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
    const { auction_id, bidder_name, amount, token } = call.request;

    if (!auction_id || !bidder_name || !amount || !token) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'auction_id, bidder_name, amount, and token are required',
      });
    }

    // Validate token
    try {
      const payload = verifyToken(token);
      if (payload.username !== bidder_name) {
        return callback({
          code: grpc.status.UNAUTHENTICATED,
          message: 'Token bidder_name mismatch',
        });
      }
    } catch (err: any) {
      return callback({
        code: grpc.status.UNAUTHENTICATED,
        message: `Invalid token: ${err.message}`,
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

  // Unary — initialize auction room (called by Catalog Service)
  CreateAuctionRoom: (call: any, callback: any) => {
    const { auction_id, starting_price } = call.request;

    if (!auction_id || !starting_price) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'auction_id and starting_price are required',
      });
    }

    try {
      initAuction(auction_id, starting_price);
      console.log(`[Bidding] Created auction room: ${auction_id} with starting price Rp${starting_price.toLocaleString()}`);
      callback(null, { 
        success: true, 
        message: 'Auction room created successfully' 
      });
    } catch (err: any) {
      callback({
        code: grpc.status.INTERNAL,
        message: `Failed to create auction: ${err.message}`,
      });
    }
  },
};

// Export initAuction & closeAuction so catalog service can call these
export { initAuction, closeAuction } from './state/bid.state';
