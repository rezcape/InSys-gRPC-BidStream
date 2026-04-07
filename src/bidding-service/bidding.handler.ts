import * as grpc from '@grpc/grpc-js';
import {
  placeBid,
  getCurrentBid,
  initAuction,
  closeAuction,
  getRemainingSeconds,
  getLeaderboard,
  clearAuctionState,
} from './state/bid.state';
import { subscribe, unsubscribe, broadcast } from './state/broadcaster';
import { verifyToken } from '../shared/utils/jwt.utils';

const BID_TIMEOUT_MS = 10;
const auctionTickerMap = new Map<string, NodeJS.Timeout>();
const auctionGraceMap = new Map<string, boolean>();
const GRACE_PERIOD_MS = 2000;
const AUCTION_STATE_RETENTION_MS = 5 * 60 * 1000;

function startAuctionTicker(auctionId: string): void {
  if (auctionTickerMap.has(auctionId)) {
    clearInterval(auctionTickerMap.get(auctionId)!);
  }

  const ticker = setInterval(() => {
    const state = getCurrentBid(auctionId);
    if (!state) {
      clearInterval(ticker);
      auctionTickerMap.delete(auctionId);
      return;
    }

    const remaining = getRemainingSeconds(auctionId);

    if (remaining <= 0) {
      if (!auctionGraceMap.get(auctionId)) {
        closeAuction(auctionId); // lock bid intake immediately
        auctionGraceMap.set(auctionId, true);
        broadcast(state, 0, 'AUCTION_CLOSING');

        setTimeout(() => {
          const latestState = getCurrentBid(auctionId);
          if (latestState) {
            broadcast(latestState, 0, 'AUCTION_CLOSED');
          }

          clearInterval(ticker);
          auctionTickerMap.delete(auctionId);
          auctionGraceMap.delete(auctionId);

          // Keep state briefly for result/leaderboard fetch, then cleanup memory
          setTimeout(() => {
            clearAuctionState(auctionId);
          }, AUCTION_STATE_RETENTION_MS);
        }, GRACE_PERIOD_MS);
      }
      return;
    }

    broadcast(state, remaining, 'TIMER_TICK');
  }, 1000);

  auctionTickerMap.set(auctionId, ticker);
}

function grpcCodeFromFailure(reason?: string): grpc.status {
  if (reason === 'NOT_FOUND') return grpc.status.NOT_FOUND;
  if (reason === 'FAILED_PRECONDITION') return grpc.status.FAILED_PRECONDITION;
  return grpc.status.UNKNOWN;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('BID_TIMEOUT'));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function rejectStream(call: any, message: string): void {
  call.emit('error', {
    code: grpc.status.UNAUTHENTICATED,
    message,
  });
}

export const biddingHandlers = {
  // Bidirectional Streaming — jantung sistem
  LiveBidding: (call: grpc.ServerDuplexStream<any, any>) => {
    let currentAuctionId: string | null = null;

    call.on('data', async (bidRequest) => {
      const { auction_id, bidder_name, amount, token } = bidRequest;

      // Validate token
      if (!token) {
        console.log(`[Bidding] Rejected bid: no token provided`);
        rejectStream(call, 'No token provided');
        return;
      }

      try {
        const payload = verifyToken(token);
        // Ensure bidder_name matches authenticated user
        if (payload.username !== bidder_name) {
          console.log(`[Bidding] Rejected bid: bidder_name mismatch (${payload.username} != ${bidder_name})`);
          rejectStream(call, 'Token bidder_name mismatch');
          return;
        }
      } catch (err: any) {
        console.log(`[Bidding] Rejected bid: invalid token (${err.message})`);
        rejectStream(call, `Invalid token: ${err.message}`);
        return;
      }

      // Subscribe client to this auction on first message
      if (currentAuctionId !== auction_id) {
        if (currentAuctionId) unsubscribe(currentAuctionId, call);
        currentAuctionId = auction_id;
        subscribe(auction_id, call);
      }

      let result;
      try {
        result = await withTimeout(placeBid(auction_id, bidder_name, amount), BID_TIMEOUT_MS);
      } catch (err: any) {
        if (err?.message === 'BID_TIMEOUT') {
          call.write({
            auction_id,
            highest_bidder: '',
            highest_amount: 0,
            timestamp: Date.now(),
          });
          return;
        }
        throw err;
      }

      if (result.success) {
        const state = getCurrentBid(auction_id);
        if (state) broadcast(state, getRemainingSeconds(auction_id), 'BID_UPDATE'); // Push update to all connected clients
      } else {
        // Notify only this client their bid was rejected
        call.write({
          auction_id,
          highest_bidder: '',
          highest_amount: result.currentHighest,
          timestamp: Date.now(),
          remaining_seconds: getRemainingSeconds(auction_id),
          event_type: 'BID_REJECTED',
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

  // Client streaming — receive continuous bid flow and respond once stream ends
  StreamBids: (call: grpc.ServerReadableStream<any, any>, callback: any) => {
    let finalResponse = {
      success: true,
      message: 'Bids processed',
      current_highest: 0,
    };

    let firstError: { code: grpc.status; message: string } | null = null;

    call.on('data', async (bidRequest: any) => {
      const { auction_id, bidder_name, amount, token } = bidRequest;

      if (firstError) return;

      if (!auction_id || !bidder_name || !amount || !token) {
        firstError = {
          code: grpc.status.INVALID_ARGUMENT,
          message: 'auction_id, bidder_name, amount, and token are required',
        };
        return;
      }

      try {
        const payload = verifyToken(token);
        if (payload.username !== bidder_name) {
          firstError = {
            code: grpc.status.UNAUTHENTICATED,
            message: 'Token bidder_name mismatch',
          };
          return;
        }
      } catch (err: any) {
        firstError = {
          code: grpc.status.UNAUTHENTICATED,
          message: `Invalid token: ${err.message}`,
        };
        return;
      }

      try {
        const result = await withTimeout(placeBid(auction_id, bidder_name, amount), BID_TIMEOUT_MS);
        finalResponse = {
          success: result.success,
          message: result.message,
          current_highest: result.currentHighest,
        };

        if (!result.success) {
          firstError = {
            code: grpcCodeFromFailure(result.reason),
            message: result.message,
          };
          return;
        }

        const state = getCurrentBid(auction_id);
        if (state) broadcast(state, getRemainingSeconds(auction_id), 'BID_UPDATE');
      } catch (err: any) {
        if (err?.message === 'BID_TIMEOUT') {
          firstError = {
            code: grpc.status.DEADLINE_EXCEEDED,
            message: 'Bid processing exceeded 10ms deadline',
          };
          return;
        }

        firstError = {
          code: grpc.status.INTERNAL,
          message: `Bid processing failed: ${err?.message ?? 'unknown error'}`,
        };
      }
    });

    call.on('end', () => {
      if (firstError) {
        return callback(firstError);
      }
      callback(null, finalResponse);
    });

    call.on('error', (err: any) => {
      callback({
        code: grpc.status.INTERNAL,
        message: `StreamBids stream error: ${err?.message ?? 'unknown error'}`,
      });
    });
  },

  // Server streaming — subscribers only receive updates for the chosen auction
  SendUpdate: (call: grpc.ServerWritableStream<any, any>) => {
    const { auction_id, token } = call.request;

    if (!auction_id) {
      call.emit('error', {
        code: grpc.status.INVALID_ARGUMENT,
        message: 'auction_id is required',
      });
      return;
    }

    if (!token) {
      rejectStream(call, 'No token provided');
      return;
    }

    try {
      verifyToken(token);
    } catch (err: any) {
      rejectStream(call, `Invalid token: ${err.message}`);
      return;
    }

    const current = getCurrentBid(auction_id);
    if (!current) {
      call.emit('error', {
        code: grpc.status.NOT_FOUND,
        message: `Auction ${auction_id} not found`,
      });
      return;
    }

    subscribe(auction_id, call);

    call.write({
      auction_id: current.auctionId,
      highest_bidder: current.highestBidder,
      highest_amount: current.highestAmount,
      timestamp: current.timestamp,
      remaining_seconds: getRemainingSeconds(auction_id),
      event_type: 'SNAPSHOT',
    });

    call.on('cancelled', () => {
      unsubscribe(auction_id, call);
    });

    call.on('error', () => {
      unsubscribe(auction_id, call);
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

    let result;
    try {
      result = await withTimeout(placeBid(auction_id, bidder_name, amount), BID_TIMEOUT_MS);
    } catch (err: any) {
      if (err?.message === 'BID_TIMEOUT') {
        return callback({
          code: grpc.status.DEADLINE_EXCEEDED,
          message: 'Bid processing exceeded 10ms deadline',
        });
      }

      return callback({
        code: grpc.status.INTERNAL,
        message: `Bid processing failed: ${err?.message ?? 'unknown error'}`,
      });
    }

    if (!result.success) {
      return callback({
        code: grpcCodeFromFailure(result.reason),
        message: result.message,
      });
    }

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

  // Unary — get top bidders leaderboard
  GetLeaderboard: (call: any, callback: any) => {
    const { auction_id, limit } = call.request;

    if (!auction_id) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'auction_id is required',
      });
    }

    const state = getCurrentBid(auction_id);
    if (!state) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: `Auction ${auction_id} not found`,
      });
    }

    const rows = getLeaderboard(auction_id, Number(limit) || 3);
    callback(null, {
      auction_id,
      entries: rows.map((row, idx) => ({
        bidder_name: row.bidderName,
        highest_bid: row.highestBid,
        rank: idx + 1,
      })),
    });
  },

  // Unary — initialize auction room (called by Catalog Service)
  CreateAuctionRoom: (call: any, callback: any) => {
    const { auction_id, starting_price, duration_seconds } = call.request;

    if (!auction_id || !starting_price) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'auction_id and starting_price are required',
      });
    }

    try {
      const duration = duration_seconds && duration_seconds > 0 ? duration_seconds : 60;
      initAuction(auction_id, starting_price, duration);
      startAuctionTicker(auction_id);
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

  // Unary — close auction room (called by Catalog Service)
  CloseAuctionRoom: (call: any, callback: any) => {
    const { auction_id } = call.request;

    if (!auction_id) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'auction_id is required',
      });
    }

    const currentState = getCurrentBid(auction_id);
    if (!currentState) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: `Auction ${auction_id} not found`,
      });
    }

    closeAuction(auction_id);
    auctionGraceMap.delete(auction_id);
    const ticker = auctionTickerMap.get(auction_id);
    if (ticker) {
      clearInterval(ticker);
      auctionTickerMap.delete(auction_id);
    }

    const stateAfterClose = getCurrentBid(auction_id);
    if (stateAfterClose) {
      broadcast(stateAfterClose, 0, 'AUCTION_CLOSED');
    }

    callback(null, {
      success: true,
      message: 'Auction room closed successfully',
    });
  },
};

// Export initAuction & closeAuction so catalog service can call these
export { initAuction, closeAuction } from './state/bid.state';
