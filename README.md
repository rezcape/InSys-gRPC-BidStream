# BidStream — Live Auction System (gRPC + Node.js + TypeScript)

## Services
| Service | Port | Type |
|---------|------|------|
| Auth Service | 50051 | Unary |
| Catalog Service | 50052 | Unary + Server Streaming |
| Bidding Engine | 50053 | Bidirectional Streaming |

## Setup
```bash
npm install
```

## Jalankan (3 terminal terpisah)
```bash
# Terminal 1 — Auth Service
npm run auth

# Terminal 2 — Catalog Service
npm run catalog

# Terminal 3 — Bidding Engine
npm run bidding
```

## Demo Multi-Client (terminal tambahan)
```bash
# Buka auction dulu (sebagai Admin)
BIDDER=Admin ts-node src/client/index.ts

# Bidder A join dengan auction_id dari output Admin
BIDDER=Alice AUCTION=<auction_id> ts-node src/client/index.ts

# Bidder B (terminal lain)
BIDDER=Budi AUCTION=<auction_id> ts-node src/client/index.ts
```

## Struktur
```
proto/          — gRPC contract definitions
src/
  auth-service/     — Register, Login, JWT (Person A)
  catalog-service/  — Items, OpenAuction, Feed (Person A)
  bidding-service/  — LiveBidding, State, Broadcaster (Person B)
  shared/           — Types, JWT utils
  client/           — Demo client
```
