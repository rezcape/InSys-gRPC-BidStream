# 📊 InSys-gRPC-BidStream — Analisis Menyeluruh

**Project Status:** ✅ ~70% Complete (Core dari Person A selesai, core dari Person B mostly done, integrasi belum sempurna)

---

## 🎯 Executive Summary

Ini adalah sistem lelang real-time berbasis **gRPC + Node.js + TypeScript** dengan 3 microservices:

| Service | Port | Owner | Status |
|---------|------|-------|--------|
| **Auth Service** | 50051 | Person A | ✅ Selesai (Register, Login, ValidateToken) |
| **Catalog Service** | 50052 | Person A | ✅ Selesai (Items, OpenAuction, Feed) |
| **Bidding Service** | 50053 | Person B | 🟡 90% (Core logic done, JWT interceptor pending) |

---

## 📐 Architecture Overview

```
┌─────────────────┐
│   Clients       │  (ts-node src/client/index.ts)
│   (Multiple)    │  Bidirectional streaming
└────────┬────────┘
         │ gRPC
    ┌────┴────────────────────┬─────────────────────┬──────────────┐
    │                         │                     │              │
┌───▼──────────────┐  ┌───────▼──────────┐  ┌──────▼────────────┐
│ Auth Service     │  │ Catalog Service  │  │ Bidding Service  │
│ (Port 50051)     │  │ (Port 50052)     │  │ (Port 50053)     │
└──────────────────┘  └──────────────────┘  └──────────────────┘
   JWT Gen/Val          Item DB + Feed        State Mgmt + Race
```

---

## 👤 Person B Scope: Bidding Engine + State Management

### ✅ Selesah yang sudah:

#### 1. **Bidding Service Core** (`src/bidding-service/server.ts`)
- ✅ gRPC server setup di port 50053
- ✅ Proto loader & package initialization
- ✅ Service registration

#### 2. **RPC Handlers** (`src/bidding-service/bidding.handler.ts`)

**a) LiveBidding (Bidirectional Streaming) — JANTUNG SISTEM**
- ✅ Subscribe/unsubscribe clients per auction
- ✅ Data handler untuk menerima bid dari client
- ✅ Broadcasting update ke semua connected clients
- ✅ Connection cleanup (end, cancelled, error)

**b) PlaceBid (Unary)**
- ✅ Fallback untuk single bid
- ✅ Basic validation

**c) GetAuctionResult (Unary)**
- ✅ Retrieve final bid result

#### 3. **State Management** (`src/bidding-service/state/bid.state.ts`)
- ✅ **Mutex per auction** untuk race condition avoidance → `async-mutex` library
- ✅ In-memory bid state map dengan lock
- ✅ Place bid dengan atomic compare-and-swap pattern
- ✅ Concurrent safety (TIDAK bisa 2 bid diterima dalam waktu bersamaan)

#### 4. **Broadcaster Hub** (`src/bidding-service/state/broadcaster.ts`)
- ✅ Subscriber map per auction
- ✅ Subscribe/unsubscribe logic
- ✅ Broadcast update ke semua subscribers
- ✅ Error handling untuk disconnected clients

#### 5. **Shared Infrastructure**
- ✅ Types (`src/shared/types.ts`) — BidState, AuctionRoom, etc.
- ✅ JWT utils (`src/shared/utils/jwt.utils.ts`) — signToken, verifyToken
- ✅ Port constants

#### 6. **Demo Client** (`src/client/index.ts`)
- ✅ End-to-end flow — Auth → Catalog → LiveBidding
- ✅ Multi-client simulation support
- ✅ Bidirectional streaming telah diimplementasikan

---

## 🟡 Apa yang BELUM sempurna (Person B's TODO):

### 1. **JWT Interceptor Integration (CRITICAL)**
**File:** `src/auth-service/interceptors/jwt.interceptor.ts` ✅ Sudah ada tapi:
- Interceptor ini di-define tapi **TIDAK DIINSTAL** di client side
- Bidding service clients dari dalam system **TIDAK punya token validation**
- Client streaming bisa bypass auth

**Action Item:** 
- Catalog Service perlu send JWT token saat call Bidding Service
- Bidding service perlu implement server-side interceptor untuk validate token

### 2. **Integration with Catalog** (MEDIUM)
- Saat Catalog `OpenAuction`, harus call `initAuction` dari Bidding Service
- Sekarang belum ada coupling antara dua service
- **Missing:** gRPC client di catalog-service untuk memanggil bidding.initAuction()

### 3. **Error Handling** (MEDIUM)
Proto sudah define error codes tapi implementation bisa lebih detail:
- ✅ INVALID_ARGUMENT untuk bid validation
- ✅ NOT_FOUND untuk auction not found
- ✅ UNAUTHENTICATED di interceptor
- 🟡 DEADLINE_EXCEEDED (timeout handling) — belum ada
- 🟡 FAILED_PRECONDITION (auction not open) — belum di-check

### 4. **Race Condition Boundary** (LOW - SUDAH AMAN)
- ✅ Mutex per auction → hanya 1 bid processed per waktu
- ✅ Atomic update ke bidStateMap
- ✅ TAPI: subscribe/unsubscribe dari broadcaster tidak di-lock (OK karena just array push/pop)

### 5. **Timestamp & Latency** (LOW)
- ✅ Timestamp di BidUpdate untuk ordering
- ✅ Klaim <10ms per bid → achievable dengan mutex pattern ini
- 🟡 Bisa add monitoring untuk actual latency

### 6. **Test Coverage** (NOT DONE)
- Tidak ada unit tests untuk race condition scenarios
- Tidak ada load testing untuk concurrent bids

---

## 📊 Current Data Flow

### Happy Path: Admin opens auction → Bidders bid

```
1. Admin (Client A)
   ├─ AuthService.Register("Admin", password)
   ├─ AuthService.Login("Admin", password) → Token A
   ├─ CatalogService.GetItems() → [items]
   ├─ CatalogService.OpenAuction(item_id=001, duration=60s) → auctionId=xxx
   │  └─ [MISSING] Catalog SHOULD call BiddingService.initAuction(xxx, startingPrice)
   └─ Monitor feeds via MonitorAuctionFeed (Server Stream)

2. Bidder B (Client B)
   ├─ AuthService.Register("Budi", password)
   ├─ AuthService.Login("Budi", password) → Token B
   └─ BiddingService.LiveBidding(Stream) ← Bidi Stream
      ├─ Write: BidRequest(auction_id=xxx, bidder=Budi, amount=100M)
      ├─ Read: BidUpdate(highest_bidder=Budi, highest_amount=100M) ✅
      └─ Repeat dengan bidAmount > 100M

3. Bidder C (Client C)
   ├─ AuthService.Register("Citra", password)
   ├─ AuthService.Login("Citra", password) → Token C
   └─ BiddingService.LiveBidding(Stream)
      ├─ Write: BidRequest(auction_id=xxx, bidder=Citra, amount=120M)
      │  └─ [Mutex] Bid accepted, state updated
      ├─ Read: BidUpdate(highest_bidder=Citra, highest_amount=120M) ✅ (ke B dan C)
      └─ Repeat

4. Timer habis (60s)
   ├─ Catalog auto-close: room.isOpen = false
   ├─ Broadcast AUCTION_CLOSED event ke feed subscribers
   └─ Bidders query: BiddingService.GetAuctionResult(xxx)
      └─ Response: {winner=Citra, final_price=120M}
```

---

## 🔐 Security Considerations

### ✅ Sudah implemented:
- JWT generation & validation
- Password hashing (SHA256 — boleh upgrade ke bcrypt)
- Token expiration (24h)

### 🟡 TODO:
- **Bidding Service HARUS validate JWT dari incoming clients**
  - Kalau client bisa skip auth, bisa bid dengan bidder_id palsu
  - Bidding.proto perlu tambah `string token` field ke BidRequest
  
- **Service-to-Service Auth (Catalog → Bidding)**
  - Catalog perlu send valid token saat init auction
  - Atau use internal gRPC secure channel

---

## 🛠 Proto File Contract (Sudah baik, minimal tweak)

### auth.proto — ✅ Good
```protobuf
service AuthService {
  rpc Register() returns ()      ✅
  rpc Login() returns ()         ✅
  rpc ValidateToken() returns () ✅
}
```

### catalog.proto — ✅ Good
```protobuf
service CatalogService {
  rpc GetItems() returns ()        ✅
  rpc OpenAuction() returns ()     ✅ (should call Bidding.initAuction)
  rpc MonitorAuctionFeed() returns (stream) ✅
}
```

### bidding.proto — 🟡 Minor improvements:
```protobuf
service BiddingService {
  rpc LiveBidding(stream) returns (stream)   ✅
  rpc PlaceBid() returns ()                  ✅
  rpc GetAuctionResult() returns ()          ✅
  
  // MISSING: Admin RPC untuk init auction dari Catalog
  // rpc InitAuction(InitAuctionRequest) returns (InitAuctionResponse);
  
  // MISSING: Untuk create new auction room
  // rpc CreateAuctionRoom(CreateRoomRequest) returns (CreateRoomResponse);
}

message BidRequest {
  string auction_id = 1;
  string bidder_id = 2;
  string bidder_name = 3;
  double amount = 4;
  // MISSING: string token = 5;  ← untuk auth
}
```

---

## 📝 Rekomendasi & Next Steps (For Person B)

### Priority 1 — CRITICAL (Do ASAP):
1. **Add JWT validation di Bidding Service**
   - Client HARUS send token di BidRequest
   - Server validate sebelum accept bid
   - Update bidding.proto add `token` field
   
2. **Add `CreateAuctionRoom()` RPC**
   - Catalog call ini saat `OpenAuction()`
   - Initialize bid state dengan starting_price
   - Return status confirmation

3. **Add error handling untuk FAILED_PRECONDITION**
   - Check `room.isOpen` sebelum accept bid
   - Return error kalau auction sudah closed

### Priority 2 — IMPORTANT (Week 1):
4. **Add timeout handling**
   - DEADLINE_EXCEEDED kalau bid processing > 10ms
   - Context.Done() untuk cancel stale bids

5. **Audit race condition edge cases**
   - Concurrent unsubscribe saat broadcast?
   - Subscription ke 2 different auctions simultaneously?
   - Network partition scenarios?

6. **Add integration test**
   - Test 3+ concurrent bidder scenarios
   - Verify final result consistency

### Priority 3 — NICE-TO-HAVE:
7. Upgrade password hashing dari SHA256 → bcrypt
8. Add metrics/logging untuk latency monitoring
9. Implement graceful shutdown
10. Add load test dengan 100+ concurrent bids

---

## ⚙️ How to Run Current State

```bash
cd /home/khosy/playground/insys/InSys-gRPC-BidStream

npm install

# Terminal 1
npm run auth

# Terminal 2
npm run catalog

# Terminal 3
npm run bidding

# Terminal 4 (Admin opens auction)
BIDDER=Admin ts-node src/client/index.ts

# Terminal 5, 6, ... (Bidders join)
BIDDER=Alice AUCTION=<auction_id> ts-node src/client/index.ts
BIDDER=Budi AUCTION=<auction_id> ts-node src/client/index.ts
```

**Expected:** Admin gets auction_id, bidders dapat real-time updates. ✅ Should work!

---

## 🎯 Critical Checkpoints Untuk Person B

- [ ] JWT token validation di BidRequest
- [ ] Catalog integrate dengan Bidding.CreateAuctionRoom
- [ ] Error handling untuk closed auctions
- [ ] Timeout handling (DEADLINE_EXCEEDED)
- [ ] Concurrent bidder test (3+ clients)
- [ ] Final result accuracy verification
- [ ] Load test (10+ concurrent bids)

---

## 📦 Dependencies Review

```json
{
  "@grpc/grpc-js": "^1.10.0",      ✅ Core gRPC
  "@grpc/proto-loader": "^0.7.10",  ✅ Proto loading
  "async-mutex": "^0.4.1",          ✅ Race condition prevention
  "jsonwebtoken": "^9.0.2",         ✅ JWT handling
  "uuid": "^9.0.0"                  ✅ ID generation
}
```

**Recommendation:** Add `bcryptjs` untuk password hashing yang lebih aman.

---

**Generated:** April 6, 2026
**Analysis for:** Person B (Bidding Engine + State)
