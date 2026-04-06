export interface User {
  id: string;
  username: string;
  passwordHash: string;
}

export interface AuctionRoom {
  auctionId: string;
  itemId: string;
  itemName: string;
  startingPrice: number;
  durationSeconds: number;
  openedAt: Date;
  isOpen: boolean;
}

export interface BidState {
  auctionId: string;
  highestBidder: string;
  highestAmount: number;
  timestamp: number;
}

export const AUTH_SERVICE_PORT = 50051;
export const CATALOG_SERVICE_PORT = 50052;
export const BIDDING_SERVICE_PORT = 50053;
export const JWT_SECRET = process.env.JWT_SECRET || 'bidstream-secret-key-change-in-prod';
