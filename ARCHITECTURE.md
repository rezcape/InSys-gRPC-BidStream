# 🔗 InSys Architecture & Integration Flow

---

## 📐 System Architecture Diagram

```
                          ┌─────────────────────┐
                          │   Admin Client      │
                          │  (BIDDER=Admin)     │
                          └──────────┬──────────┘
                                     │
                      ┌──────────────┼──────────────┐
                      │              │              │
                      │ (1) Register │ (2) GetItems │
                      │              │              │
                  ┌───▼──────┐   ┌───▼──────────┐
                  │   AUTH    │   │  CATALOG     │
                  │ (50051)   │   │  (50052)     │
                  └─────┬─────┘   └───┬──────────┘
                        │             │
                        │ Token       │ (3) OpenAuction
                        │             │
                        │         ┌───▼──────────┐
                        │         │  BIDDING     │
                        │         │  (50053)     │
                        │         └───┬──────────┘
                        │             │
                        │         initAuction()
                        │         [NEW: Person B adds this]
                        │
           ┌────────────┬────────────┬────────────┐
           │            │            │            │
        ┌──▼───┐    ┌───▼──┐   ┌────▼───┐
        │Bidder│    │Bidder│   │Bidder D│
        │Alice │    │Budi  │   │(Citra) │
        └──┬───┘    └───┬──┘   └────┬───┘
           │            │           │
           └────────────┼───────────┘
                        │
           ┌────────────▼────────────┐
           │                         │
           │  BiddingService:        │
           │  - LiveBidding(Stream)  │
           │  - State Management     │
           │  - Broadcaster Hub      │
           │                         │
           └─────────────────────────┘
```

---

## 🔄 Flow Sequence Diagram

### Happy Path: Full Auction Cycle

```
ADMIN           AUTH             CATALOG          BIDDING
 │               │                  │                │
 ├─Register──────>│                  │                │
 │                ├─Generate Token──>│                │
 │<───Token───────│                  │                │
 │                                   │                │
 ├─Login─────────>│                  │                │
 │<───Token───────│                  │                │
 │                                   │                │
 ├─GetItems────────────────────────>│                │
 │<────Items──────────────────────────│                │
 │                                   │                │
 ├─OpenAuction(item_id)──────────────>│                │
 │                        [NEW]       ├─CreateAuctionRoom──>│
 │                                    │                  ✓ Init state
 │<────auctionId──────────────────────│                │
 │                                   │                │


BIDDER_A        AUTH             CATALOG          BIDDING
 │               │                  │                │
 ├─Register──────>│                  │                │
 │<───TokenA──────│                  │                │
 │                                   │                │
 ├─LiveBidding(stream, tokenA, 100M)────────────────>│
 │                                                  ✓ Validate token
 │<──BidUpdate(Alice, 100M)──────────────────────────│
 │                                                   │
 │    ...wait 3 seconds...                          │
 │                                                   │
 ├─BidRequest(120M, tokenA)─────────────────────────>│
 │  [Mutex]                                         │
 │  ├─ Lock acquired                               │
 │  ├─ 120M > 100M? YES → Accept ✓                │
 │  └─ Release lock                                │
 │<──BidUpdate(Alice, 120M)──────────────────────────│
 │                                                   │


BIDDER_B        AUTH             CATALOG          BIDDING
 │               │                  │                │
 ├─Register──────>│                  │                │
 │<───TokenB──────│                  │                │
 │                                   │                │
 ├─LiveBidding(stream, tokenB, 110M)────────────────>│
 │                                                  ✓ Validate token
 │                                                  │
 │                 [RACE]                           │
 │                 ├─ TokenA=120M (in progress)    │
 │                 ├─ TokenB=110M (queued in mutex)│
 │                 │                                │
 │<──BidUpdate(Alice, 120M)────────────┐            │
 │                                     ├─→ Broadcast│
 │<──BidUpdate(Alice, 120M)←────────────┘
 │
 │  [BidB processed after Release]
 │  ├─ Lock acquired                                │
 │  ├─ 110M > 120M? NO → Reject ✗                │
 │<──BidUpdate(Alice, 120M)──────────────────────────│


TIMER EXPIRED (60s)

CATALOG        BIDDING
 │              │
 ├─AutoClose─> │
 │           room.isOpen = false
 │


ANY_BIDDER     BIDDING
 │              │
 ├─GetAuctionResult──>│
 │<──{winner: Alice, final_price: 120M}───│
```

---

## 🎯 Person A ↔ Person B Integration Points

### Integration Point 1: Auction Initialization
**Responsibility**: Person B
- **When**: Catalog Service calls `OpenAuction()`
- **What**: Person B's Bidding Service MUST have `CreateAuctionRoom()` RPC
- **Proto needed**:
  ```protobuf
  rpc CreateAuctionRoom(CreateAuctionRoomRequest) 
    returns (CreateAuctionRoomResponse);
  ```

**Current state**: 
- ✅ `initAuction()` function exists in `bid.state.ts`
- ❌ RPC endpoint NOT exposed in proto
- ❌ Catalog NOT calling it

### Integration Point 2: JWT Token Validation
**Responsibility**: Person B
- **When**: Bidder sends `BidRequest` via LiveBidding stream
- **What**: Person B MUST validate JWT token before accepting bid
- **Method**: Use existing `verifyToken()` from `shared/utils/jwt.utils.ts`

**Current state**:
- ✅ `verifyToken()` function exists
- ❌ `BidRequest` proto MISSING `token` field
- ❌ Handler NOT validating token

### Integration Point 3: Auction Status Check
**Responsibility**: Person B
- **When**: Checking if auction is still open
- **What**: Person B MUST import `auctionRooms` from Catalog Service
- **How**: Check `room.isOpen` sebelum accept bid

**Current state**:
- ❌ No dependency dari Bidding ke Catalog
- ❌ Bisa accept bid untuk closed auction (BUG)

---

## 📊 Data Flow с Dependencies

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: Auth Infrastructure (Person A) [DONE]             │
│                                                             │
│  Client → AuthService → JWT Generation                    │
│  Result: Token stored in client memory                    │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ Phase 2: Catalog + Item Management (Person A) [DONE]      │
│                                                             │
│  Client → CatalogService → Item DB + Auction Rooms       │
│  Result: auctionId generated, room created locally        │
│          [BUT NOT in Bidding Service]                     │
└─────────────────────────────────────────────────────────────┘
                           ↓
           [MISSING INTEGRATION]
                           ↓
    Person B MUST add: CatalogService → BiddingService
             Catalog.OpenAuction calls Bidding.CreateAuctionRoom
            ✅ Initialize bid state saat auction dibuka
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ Phase 3: Bidding Engine (Person B) [PARTIALLY DONE]       │
│                                                             │
│  Client sends: BidRequest(token, auctionId, amount)       │
│  [MISSING: token parameter]                               │
│                                                             │
│  BiddingService:                                            │
│  1. Validate token ← [MISSING]                            │
│  2. Check auction.isOpen ← [MISSING]                      │
│  3. Acquire mutex for this auction                        │
│  4. Validate amount > currentHighest                      │
│  5. Update state                                          │
│  6. Release mutex                                         │
│  7. Broadcast to all subscribers                          │
│                                                             │
│  Result: Consistent bid state, no race conditions         │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚨 Critical Dependencies

### Catalog → Bidding (NEW)
```
File: src/catalog-service/catalog.handler.ts
Function: OpenAuction()

BEFORE:
  ├─ Create room locally: auctionRooms.set(auctionId)
  └─ Done

AFTER (Person B must enable this):
  ├─ Create room locally: auctionRooms.set(auctionId)
  ├─ Call Bidding.CreateAuctionRoom(auctionId, startingPrice)
  └─ Done
```

**Action**: Person B implements RPC, Catalog calls it.

### Bidding ← Catalog (NEW)
```
File: src/bidding-service/state/bid.state.ts
Function: placeBid()

BEFORE:
  ├─ Check: amount > currentHighest
  ├─ Update stake
  └─ Return success

AFTER (Person B must add this):
  ├─ Import auctionRooms from Catalog
  ├─ Check: auctionRooms[auctionId].isOpen
  ├─ Return FAILED_PRECONDITION if closed
  ├─ Validate token from caller
  ├─ Check: amount > currentHighest
  ├─ Update stake
  └─ Return success
```

**Action**: Person B adds validation before bid acceptance.

---

## 🔐 Authentication Flow In Detail

### Current (Person A - Done)
```
User → Auth.Register() → Hash password + Save
                      → Generate JWT token
                      → Return token to client

User → Auth.Login()   → Hash password check
                      → Generate JWT token
                      → Return token to client
```

### Person B MUST DO: Token Validation in Bidding

```
Client BidRequest
  ├─ auction_id: "xxx"
  ├─ bidder_name: "Alice"
  ├─ amount: 100M
  └─ token: "eyJhbGc..." ← [MISSING IN PROTO]
         │
         ▼
BiddingService.LiveBidding()
  ├─ Extract token
  ├─ Call verifyToken(token)
  │ └─ JWT.verify() → payload: {userId, username}
  │ └─ If invalid → Reject bid, close stream
  ├─ Validate: payload.username == bidder_name
  │ └─ If mismatch → Reject bid (spoofed)
  └─ Accept bid ✓
```

**Where to add:**
```typescript
// File: src/bidding-service/bidding.handler.ts

call.on('data', async (bidRequest) => {
  const { auction_id, bidder_name, amount, token } = bidRequest;  // ← token added
  
  // NEW: Validate token
  if (!token) {
    call.write({...error});
    return;
  }
  
  try {
    const payload = verifyToken(token);
    if (payload.username !== bidder_name) {
      call.write({...error});
      return;
    }
  } catch {
    call.write({...error});
    return;
  }
  
  // Existing logic continues...
});
```

---

## 📦 File Modification Summary

### Files Person B MUST modify:

| File | Changes | Type |
|------|---------|------|
| `proto/bidding.proto` | Add `token` to BidRequest; Add `CreateAuctionRoom` RPC | ✏️ Add fields |
| `state/bid.state.ts` | Add auction room validation; Add token validation | ✏️ Add logic |
| `bidding.handler.ts` | Implement `CreateAuctionRoom` handler; Validate token in LiveBidding | ✏️ Add handler |

### Files Person A needs to update (for integration):

| File | Changes | Type |
|------|---------|------|
| `proto/bidding.proto` | [Same as above] | ✏️ Receive update |
| `catalog-service/catalog.handler.ts` | Call `Bidding.CreateAuctionRoom()` | ✏️ Add call |
| `client/index.ts` | Send token in BidRequest | ✏️ Add field |

---

## ✅ Validation Checklist

After Person B completes integration:

- [ ] Proto files: `bidding.proto` has `token` field in `BidRequest`
- [ ] Proto files: `CreateAuctionRoom` RPC defined
- [ ] Server: `bidding.handler.ts` has `CreateAuctionRoom` implementation
- [ ] Server: Token validation present in `LiveBidding` data handler
- [ ] Server: Auction open status check present in `placeBid()`
- [ ] Client: Sends token in `BidRequest`
- [ ] Catalog: Calls `Bidding.CreateAuctionRoom()` in `OpenAuction()`
- [ ] E2E test: Admin opens auction → 2+ bidders bid → Consistent results

---

