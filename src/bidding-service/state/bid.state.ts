import { Mutex } from 'async-mutex';
import { BidState } from '../../shared/types';

// Mutex per auction room to prevent race conditions
const mutexMap = new Map<string, Mutex>();
const bidStateMap = new Map<string, BidState>();
const auctionStatusMap = new Map<string, boolean>(); // Track auction open/closed status

export type BidFailureReason = 'NOT_FOUND' | 'FAILED_PRECONDITION';

export interface BidResult {
  success: boolean;
  message: string;
  currentHighest: number;
  reason?: BidFailureReason;
}

function getMutex(auctionId: string): Mutex {
  if (!mutexMap.has(auctionId)) {
    mutexMap.set(auctionId, new Mutex());
  }
  return mutexMap.get(auctionId)!;
}

export async function placeBid(
  auctionId: string,
  bidderName: string,
  amount: number
): Promise<BidResult> {
  const mutex = getMutex(auctionId);

  // Ensure auction room exists
  if (!bidStateMap.has(auctionId)) {
    return {
      success: false,
      message: `Auction ${auctionId} not found`,
      currentHighest: 0,
      reason: 'NOT_FOUND',
    };
  }

  // Check if auction is open
  const isOpen = auctionStatusMap.get(auctionId);
  if (isOpen === false) {
    const current = bidStateMap.get(auctionId);
    return {
      success: false,
      message: `Auction ${auctionId} is closed`,
      currentHighest: current?.highestAmount ?? 0,
      reason: 'FAILED_PRECONDITION',
    };
  }

  // Acquire lock — only one bid processed at a time per auction
  const release = await mutex.acquire();

  try {
    // Re-check status after lock in case auction closed while waiting for mutex
    if (auctionStatusMap.get(auctionId) === false) {
      const current = bidStateMap.get(auctionId);
      return {
        success: false,
        message: `Auction ${auctionId} is closed`,
        currentHighest: current?.highestAmount ?? 0,
        reason: 'FAILED_PRECONDITION',
      };
    }

    const current = bidStateMap.get(auctionId);
    const currentHighest = current?.highestAmount ?? 0;

    if (amount <= currentHighest) {
      return {
        success: false,
        message: `Bid too low. Current highest: ${currentHighest}`,
        currentHighest,
        reason: 'FAILED_PRECONDITION',
      };
    }

    const newState: BidState = {
      auctionId,
      highestBidder: bidderName,
      highestAmount: amount,
      timestamp: Date.now(),
    };

    bidStateMap.set(auctionId, newState);
    console.log(`[State] New highest bid: ${bidderName} — Rp${amount.toLocaleString()}`);

    return { success: true, message: 'Bid accepted', currentHighest: amount };
  } finally {
    release(); // Always release mutex
  }
}

export function getCurrentBid(auctionId: string): BidState | undefined {
  return bidStateMap.get(auctionId);
}

export function initAuction(auctionId: string, startingPrice: number): void {
  bidStateMap.set(auctionId, {
    auctionId,
    highestBidder: '',
    highestAmount: startingPrice,
    timestamp: Date.now(),
  });
  auctionStatusMap.set(auctionId, true); // Mark as open
}

export function closeAuction(auctionId: string): void {
  auctionStatusMap.set(auctionId, false); // Mark as closed
}
