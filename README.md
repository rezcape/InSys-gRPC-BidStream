# BidStream - Live Auction System (gRPC + Node.js + TypeScript)

Setiap kelompok membangun sebuah implementasi sistem komunikasi antar-layanan (Client-Server) menggunakan protokol gRPC.

Contoh topik: Chat System, System Monitoring Dashboard, Real-Time Quiz System, Food Delivery Tracking, IoT Smart Home Simulator, Smart Parking Management System.

Topik tersebut hanya contoh. Bebas gunakan AI, implementasi semakin kreatif dan kompleks maka nilai semakin baik.

Durasi 2 minggu. Minggu ke 5 presentasi projek. Minggu ke 6 demo akhir projek.

Project ini mengangkat topik **real-time auction** dengan 3 service: Auth, Catalog, dan Bidding Engine.

## Arsitektur Service

| Service | Port | Fungsi |
|---------|------|--------|
| Auth Service | 50051 | Register, Login, Validate Token |
| Catalog Service | 50052 | GetItems, OpenAuction, MonitorAuctionFeed |
| Bidding Service | 50053 | LiveBidding, StreamBids, SendUpdate, Result |

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
cd /home/khosy/playground/insys/InSys-gRPC-BidStream
npm run auth

# Terminal 2
cd /home/khosy/playground/insys/InSys-gRPC-BidStream
npm run catalog

# Terminal 3
cd /home/khosy/playground/insys/InSys-gRPC-BidStream
npm run bidding
```

## Alur Demo Cepat

1. Admin membuka auction:

```bash
cd /home/khosy/playground/insys/InSys-gRPC-BidStream
BIDDER=Admin npm run client
```

Ambil nilai `AUCTION=<auction_id>` dari output.

2. Jalankan bidder A dan B di terminal berbeda:

```bash
cd /home/khosy/playground/insys/InSys-gRPC-BidStream
BIDDER=Alice AUCTION=<auction_id> npm run client
```

```bash
cd /home/khosy/playground/insys/InSys-gRPC-BidStream
BIDDER=Budi AUCTION=<auction_id> npm run client
```

3. Cek hasil akhir auction:

```bash
cd /home/khosy/playground/insys/InSys-gRPC-BidStream
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

## Dokumentasi Gambar (Isi Saat Final)

1. [Masukkan Gambar 1 - Diagram arsitektur 3 service]
2. [Masukkan Gambar 2 - Terminal saat service auth/catalog/bidding running]
3. [Masukkan Gambar 3 - Admin membuka auction dan mendapatkan auction_id]
4. [Masukkan Gambar 4 - Multi-client bidding realtime (Alice & Budi)]
5. [Masukkan Gambar 5 - Hasil akhir GetAuctionResult]

## Catatan Singkat Presentasi

- Fokus tunjukkan: unary, streaming, error handling, state management, multi-client.
- Tunjukkan satu auction end-to-end dari open -> bidding -> final result.
