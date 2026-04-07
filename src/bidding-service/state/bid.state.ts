import { Mutex } from 'async-mutex';
import { BidState } from '../../shared/types';

// Mutex per auction room to prevent race conditions
const mutexMap = new Map<string, Mutex>();
const bidStateMap = new Map<string, BidState>();
const auctionStatusMap = new Map<string, boolean>(); // Track auction open/closed status
const auctionEndAtMap = new Map<string, number>();
const bidHistoryMap = new Map<string, { bidderName: string; amount: number; timestamp: number }[]>();
const extensionCountMap = new Map<string, number>();
const EXTEND_WINDOW_SECONDS = 10;
const RESET_TO_SECONDS = 10;
const MAX_ANTI_SNIPING_EXTENSIONS = 3;
const MIN_INCREMENT_ABSOLUTE = 1_000_000;

export type BidFailureReason = 'NOT_FOUND' | 'FAILED_PRECONDITION';

export interface BidResult {
  success: boolean;
  message: string;
  currentHighest: number;
  reason?: BidFailureReason;
}

export interface LeaderboardRow {
  bidderName: string;
  highestBid: number;
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
  if (isOpen === false || getRemainingSeconds(auctionId) <= 0) {
    auctionStatusMap.set(auctionId, false);
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
    const minIncrement = Math.max(MIN_INCREMENT_ABSOLUTE, Math.ceil(currentHighest * 0.01));
    const minNextBid = currentHighest + minIncrement;

    if (amount < minNextBid) {
      return {
        success: false,
        message: `Bid too low. Minimum next bid: ${minNextBid}`,
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

    const endAt = auctionEndAtMap.get(auctionId);
    if (endAt) {
      const remainingMs = endAt - Date.now();
      const extensionCount = extensionCountMap.get(auctionId) ?? 0;
      if (
        remainingMs > 0 &&
        remainingMs <= EXTEND_WINDOW_SECONDS * 1000 &&
        extensionCount < MAX_ANTI_SNIPING_EXTENSIONS
      ) {
        const resetEndAt = Date.now() + RESET_TO_SECONDS * 1000;
        auctionEndAtMap.set(auctionId, resetEndAt);
        extensionCountMap.set(auctionId, extensionCount + 1);
        console.log(
          `[State] Anti-sniping: auction ${auctionId} reset to ${RESET_TO_SECONDS}s (${extensionCount + 1}/${MAX_ANTI_SNIPING_EXTENSIONS})`
        );
      }
    }

    const history = bidHistoryMap.get(auctionId) ?? [];
    history.push({ bidderName, amount, timestamp: newState.timestamp });
    bidHistoryMap.set(auctionId, history);

    console.log(`[State] New highest bid: ${bidderName} — Rp${amount.toLocaleString()}`);

    return { success: true, message: 'Bid accepted', currentHighest: amount };
  } finally {
    release(); // Always release mutex
  }
}

export function getCurrentBid(auctionId: string): BidState | undefined {
  return bidStateMap.get(auctionId);
}

export function initAuction(auctionId: string, startingPrice: number, durationSeconds: number = 180): void {
  bidStateMap.set(auctionId, {
    auctionId,
    highestBidder: '',
    highestAmount: startingPrice,
    timestamp: Date.now(),
  });
  auctionStatusMap.set(auctionId, true); // Mark as open
  auctionEndAtMap.set(auctionId, Date.now() + durationSeconds * 1000);
  bidHistoryMap.set(auctionId, []);
  extensionCountMap.set(auctionId, 0);
}

export function closeAuction(auctionId: string): void {
  auctionStatusMap.set(auctionId, false); // Mark as closed
}

export function getRemainingSeconds(auctionId: string): number {
  const endAt = auctionEndAtMap.get(auctionId);
  if (!endAt) return 0;
  const remainingMs = endAt - Date.now();
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

export function getLeaderboard(auctionId: string, limit: number = 3): LeaderboardRow[] {
  const history = bidHistoryMap.get(auctionId) ?? [];
  const bestByBidder = new Map<string, number>();

  history.forEach((entry) => {
    const prev = bestByBidder.get(entry.bidderName) ?? 0;
    if (entry.amount > prev) {
      bestByBidder.set(entry.bidderName, entry.amount);
    }
  });

  return Array.from(bestByBidder.entries())
    .map(([bidderName, highestBid]) => ({ bidderName, highestBid }))
    .sort((a, b) => b.highestBid - a.highestBid)
    .slice(0, Math.max(1, limit));
}

export function clearAuctionState(auctionId: string): void {
  bidStateMap.delete(auctionId);
  auctionStatusMap.delete(auctionId);
  auctionEndAtMap.delete(auctionId);
  bidHistoryMap.delete(auctionId);
  extensionCountMap.delete(auctionId);
  mutexMap.delete(auctionId);
}
