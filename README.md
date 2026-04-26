# BidStream - Live Auction System (gRPC + Node.js + TypeScript)

## Arsitektur Service

| Nama | NRP |
|------|-----|
| Ahmad Syauqi Reza | 5027241085 |
| Muhammad Khosyi Syehab | 5027241089 |

## Arsitektur Service

| Service | Port | Type | Fungsi |
|---------|------|------|--------|
| Auth Service | 50051 | Unary | Register, Login, Validate Token |
| Catalog Service | 50052 | Unary + Server Streaming | GetItems, OpenAuction, MonitorAuctionFeed |
| Bidding Service | 50053 | Bidirectional Streaming | LiveBidding, StreamBids, SendUpdate, Result |

## Fitur Wajib

1. Request-response (Unary) gRPC
- Sudah ada di Auth, Catalog, dan Bidding.

2. Streaming gRPC: Wajib memilih minimal 1 antara Server-side Streaming, Client-side Streaming, atau Bi-directional Streaming.
- Server-side: `MonitorAuctionFeed`, `SendUpdate`
- Client-side: `StreamBids`
- Bi-directional: `LiveBidding`

3. Error Handling
- Menggunakan status gRPC seperti `NOT_FOUND`, `FAILED_PRECONDITION`, `DEADLINE_EXCEEDED`, `UNAUTHENTICATED`.

4. State management in-memory server (atau boleh menggunakan database)
- Bidding state disimpan in-memory map + mutex (race condition safe).
- Auction room state disimpan in-memory di Catalog dan Bidding.

5. Multi client
- Banyak bidder bisa join auction yang sama di terminal berbeda.

6. Minimal 3 services
- Auth Service, Catalog Service, Bidding Service.

## Setup

```bash
npm install
```

## Cara Menjalankan

Jalankan 3 service terlebih dahulu (3 terminal berbeda):

```bash
# Terminal 1
npm run auth

# Terminal 2
npm run catalog

# Terminal 3
npm run bidding
```

## Alur Demo Cepat

1. Admin membuka auction:

```bash
BIDDER=Admin npm run client
```

Ambil nilai `AUCTION=<auction_id>` dari output.

2. Jalankan bidder A dan B di terminal berbeda:

```bash
BIDDER=Alice AUCTION=<auction_id> npm run client
```

```bash
BIDDER=Budi AUCTION=<auction_id> npm run client
```

3. Cek hasil akhir auction:

```bash
node - <<'NODE'
const grpc=require('@grpc/grpc-js');
const loader=require('@grpc/proto-loader');
const path=require('path');
const def=loader.loadSync(path.join(process.cwd(),'proto/bidding.proto'),{keepCase:true,longs:String,enums:String,defaults:true,oneofs:true});
const proto=grpc.loadPackageDefinition(def);
const client=new proto.bidding.BiddingService('localhost:50053', grpc.credentials.createInsecure());
client.GetAuctionResult({auction_id:'<auction_id>'},(err,res)=>{ if(err) return console.error(err); console.log(res); });
NODE
```

## Struktur Folder

```text
proto/
  auth.proto
  catalog.proto
  bidding.proto

src/
  auth-service/
  catalog-service/
  bidding-service/
  client/
  shared/
```