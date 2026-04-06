# 🎯 Person B: Bidding Engine Implementation Checklist

**Status:** Core adalah 90% done, integration adalah missing piece 🟡

---

## ✅ Already Implemented (Don't touch!)

### Phase 1: Proto Design ✅
- [x] `proto/bidding.proto` — service, messages defined
- [x] Message types — BidRequest, BidUpdate, BidResponse, etc.

### Phase 2: Bidding Engine Core ✅
- [x] `bidding-service/server.ts` — gRPC server setup
- [x] `bidding-service/bidding.handler.ts` — 3 RPC handlers
  - [x] `LiveBidding()` — bidi stream core logic
  - [x] `PlaceBid()` — unary fallback
  - [x] `GetAuctionResult()` — result retrieval
- [x] `state/bid.state.ts` — mutex-based race condition prevention
- [x] `state/broadcaster.ts` — subscriber hub & broadcast mechanism

### Phase 3: Integration Ready ✅
- [x] Client demo working (multi-client simulation)
- [x] Basic happy path flow

---

## 🟡 TODO: CRITICAL (Do first!)

### Task 1: Add JWT to BidRequest
**Files to modify:**
- `proto/bidding.proto` — add `string token` parameter
- `bidding-service/bidding.handler.ts` — extract & validate token dari request

**Changes needed:**

#### 1a. Update proto/bidding.proto
```protobuf
message BidRequest {
  string auction_id = 1;
  string bidder_id = 2;
  string bidder_name = 3;
  double amount = 4;
  string token = 5;  // ← ADD THIS
}
```

**Why:** Prevent spoofed bids dengan bidder_name palsu. Client harus authenticated.

#### 1b. Update bidding.handler.ts
```typescript
import { verifyToken } from '../shared/utils/jwt.utils';

// Di dalam LiveBidding data handler
call.on('data', async (bidRequest) => {
  const { auction_id, bidder_name, amount, token } = bidRequest;
  
  // Validate token
  if (!token) {
    return; // Reject bid silently atau send error message
  }
  
  try {
    const payload = verifyToken(token);
    // Ensure bidder_name matches authenticated user
    if (payload.username !== bidder_name) {
      return; // Spoofed bid, reject
    }
  } catch {
    return; // Invalid token, reject
  }
  
  // ... rest of bid logic
});
```

**Expected impact:** ✅ Bids authenticated per user

---

### Task 2: Add CreateAuctionRoom RPC
**Files to modify:**
- `proto/bidding.proto` — add new RPC definition
- `bidding-service/bidding.handler.ts` — implement handler
- `src/catalog-service/catalog.handler.ts` — call this RPC dari OpenAuction

**Changes needed:**

#### 2a. Update proto/bidding.proto
```protobuf
service BiddingService {
  rpc LiveBidding(stream BidRequest) returns (stream BidUpdate);
  rpc PlaceBid(BidRequest) returns (BidResponse);
  rpc GetAuctionResult(AuctionResultRequest) returns (AuctionResultResponse);
  rpc CreateAuctionRoom(CreateAuctionRoomRequest) returns (CreateAuctionRoomResponse);  // ← ADD
}

message CreateAuctionRoomRequest {
  string auction_id = 1;
  double starting_price = 2;
}

message CreateAuctionRoomResponse {
  bool success = 1;
  string message = 2;
}
```

#### 2b. Update bidding.handler.ts
```typescript
CreateAuctionRoom: (call: any, callback: any) => {
  const { auction_id, starting_price } = call.request;
  
  try {
    initAuction(auction_id, starting_price);
    console.log(`[Bidding] Created auction room: ${auction_id}`);
    callback(null, { success: true, message: 'Auction room created' });
  } catch (err: any) {
    callback({
      code: grpc.status.INTERNAL,
      message: `Failed to create auction: ${err.message}`,
    });
  }
},
```

#### 2c. Update catalog.handler.ts — OpenAuction

**Before:**
```typescript
OpenAuction: (call: any, callback: any) => {
  // ... create auction room locally
  auctionRooms.set(auctionId, room);
  // ...
};
```

**After:**
```typescript
import { createBiddingChannel } from '../shared/grpc-clients';  // ← NEW

OpenAuction: (call: any, callback: any) => {
  const { item_id, duration_seconds } = call.request;
  const item = itemDatabase.get(item_id);

  if (!item) {
    return callback({
      code: grpc.status.NOT_FOUND,
      message: `Item ${item_id} not found`,
    });
  }

  const auctionId = uuidv4();
  const room: AuctionRoom = {
    auctionId,
    itemId: item_id,
    itemName: item.name,
    startingPrice: item.starting_price,
    durationSeconds: duration_seconds || 60,
    openedAt: new Date(),
    isOpen: true,
  };

  auctionRooms.set(auctionId, room);
  
  // ← NEW: Call Bidding Service
  const biddingClient = createBiddingChannel();
  biddingClient.CreateAuctionRoom(
    {
      auction_id: auctionId,
      starting_price: item.starting_price,
    },
    (err: any, res: any) => {
      if (err) {
        console.error(`[Catalog] Failed to init bidding: ${err.message}`);
      } else {
        console.log(`[Catalog] Bidding room initialized for ${auctionId}`);
      }
    }
  );

  console.log(`[Catalog] Auction opened: ${auctionId} for ${item.name}`);

  // ... rest of routine (broadcast, auto-close)
};
```

**Why:** Sekarang bid state di-establish saat auction dibuka, bukan lazy-loaded.

**Expected impact:** ✅ Coordinated auction lifecycle

---

### Task 3: Add Auction Status Validation
**File:** `bidding-service/bidding.handler.ts`

**Why:** Prevent bids setelah auction closed

**Changes:**

```typescript
import { auctionRooms } from '../../catalog-service/catalog.handler';  // ← Import from catolog

// Di dalam placeBid function
async function placeBid(
  auctionId: string,
  bidderName: string,
  amount: number
): Promise<{ success: boolean; message: string; currentHighest: number }> {
  
  // NEW: Check auction is open
  const room = auctionRooms.get(auctionId);
  if (!room || !room.isOpen) {
    return {
      success: false,
      message: `Auction ${auctionId} is not open`,
      currentHighest: 0,
    };
  }

  const mutex = getMutex(auctionId);
  const release = await mutex.acquire();

  try {
    // ... existing bid logic
  } finally {
    release();
  }
}
```

**Expected impact:** ✅ FAILED_PRECONDITION error handling done

---

## 🟠 TODO: IMPORTANT (Week 1)

### Task 4: Add Timeout Handling
```typescript
// Di bidding.handler.ts LiveBidding

call.on('data', async (bidRequest) => {
  const { auction_id, bidder_name, amount, token } = bidRequest;

  const startTime = Date.now();
  
  try {
    const result = await placeBid(auction_id, bidder_name, amount);
    const elapsed = Date.now() - startTime;
    
    if (elapsed > 10) {
      console.warn(`[Performance] Bid took ${elapsed}ms (target <10ms)`);
    }
    
    // ... send update
  } catch (err) {
    // Handle timeout
    call.write({
      auction_id,
      highest_bidder: '',
      highest_amount: 0,
      timestamp: Date.now(),
      // Add new field untuk error: error_message: "Timeout"
    });
  }
});
```

---

### Task 5: Test Race Conditions
**File:** Create `test/race-condition.test.ts`

```typescript
/**
 * Scenario: 100 concurrent bids
 * Expected: Only highest bid accepted, mutex prevents dupe processing
 */
test('100 concurrent bids should maintain order', async () => {
  const auctionId = 'test-001';
  initAuction(auctionId, 1000000); // Starting price

  const promises = [];
  for (let i = 0; i < 100; i++) {
    const amount = 1000000 + (i + 1) * 100000;
    promises.push(
      placeBid(auctionId, `Bidder${i}`, amount)
    );
  }

  const results = await Promise.all(promises);

  // Only 1 bid should succeed per round
  const successful = results.filter(r => r.success).length;
  const final = getCurrentBid(auctionId);

  expect(final?.highestAmount).toBe(1000000 + 100 * 100000);
});
```

---

## 🟢 TODO: NICE-TO-HAVE (Later)

- [ ] Upgrade password hashing SHA256 → bcrypt
- [ ] Add latency metrics monitoring
- [ ] Add graceful shutdown helpers
- [ ] Load test 1000+ bids/sec
- [ ] Circuit breaker pattern untuk service calls
- [ ] Implement auction expiration queue

---

## 📋 Work Order (Suggested Sequence)

### Phase 1: Proto + Core API (1-2 hours)
- [ ] Task 1: Add JWT to BidRequest
- [ ] Task 2: Add CreateAuctionRoom RPC

### Phase 2: Integration (1-2 hours)
- [ ] Update Catalog.OpenAuction to call Bidding.CreateAuctionRoom
- [ ] Update Client to send token in BidRequest
- [ ] Test happy path with 2-3 bidders

### Phase 3: Validation (1 hour)
- [ ] Task 3: Auction status validation
- [ ] Test closed auction rejection

### Phase 4: Quality (2-3 hours)
- [ ] Task 4: Timeout handling
- [ ] Task 5: Race condition tests
- [ ] Multi-client concurrent test

---

## 🚀 Success Criteria

- [x] Proto definitions correct and complete
- [ ] 3 bidders can concurrent bid without data corruption
- [ ] Final result is consistent (only highest bid wins)
- [ ] Mutex prevents duplicate processing
- [ ] JWT validation prevents spoofed bids
- [ ] Closed auctions reject new bids
- [ ] All handlers respond within <10ms average

---

