# System Architecture

## Solana Momentum Sniper Bot

This document is the master architectural reference for the project. It describes how the system is organized, why it is organized that way, and how the pieces fit together. Every other document in this project either references this one or elaborates on a specific part of it. If you are picking up this project after time away, or if you are an AI assistant being given context about the project, this is the document to read first.

The document is written in prose because the reasoning behind architectural decisions matters as much as the decisions themselves. A bullet-point summary would tell you what the architecture is. The full text tells you why it is that way and what would have to change for a different choice to be correct. That distinction is the difference between knowing the system and being able to maintain it.

---

## Part One: What We Are Building

The project is a personal trading bot for Solana memecoins. It detects newly launched tokens across major launchpads, evaluates them against a set of strategies, and trades selectively when those strategies identify high-quality opportunities. It manages the resulting positions with automated exit rules, prioritizing capital preservation over maximum profit on any single trade.

The bot is explicitly not built to compete on raw speed with professional sniping operations. Those operations run co-located bare-metal infrastructure with custom Rust implementations and direct validator connections. We will not win that race, and trying to win it is the path most retail bots take to losing money. Instead, the bot competes on selectivity and discipline. It says no to ninety-nine percent of opportunities, takes positions only on the strongest signals, and exits with the kind of consistency that humans cannot maintain when emotionally invested in a trade.

The strategy this implies is one of expected value rather than win rate. We accept that many trades will lose money. We design the system so that the winners produce enough upside to compensate for the losers, and so that no single losing trade can do disproportionate damage. This framing is essential to understanding every architectural choice that follows. The bot is a probabilistic system that succeeds over hundreds of trades, not a magic oracle that picks winners.

The project follows a phased rollout. Phase one is observation only, with the bot detecting and analyzing tokens but not trading. Phase two adds paper trading, where the bot makes simulated trades and tracks their outcomes without risking real money. Phase three introduces small real trades with manual entry and automated exits. Phase four enables fully automated entry and exit. Each phase requires the previous phase to demonstrate edge before proceeding. If phase one shows the filtering logic does not produce profitable signals in simulation, we stop before any real money is at risk.

---

## Part Two: The System Boundary

Before describing the internal structure of the system, we need to be clear about what is inside the system and what is outside. This distinction matters because the two require different defensive strategies. Inside the boundary, code is something we control and can fix when it breaks. Outside the boundary, we depend on services and networks that can fail at any moment, and our job is to handle those failures gracefully rather than to prevent them.

The bot depends on several external services. Helius provides our connection to the Solana blockchain, both for receiving streams of new launches through subscription endpoints and for making request-response queries about specific accounts and transactions. The specific subscription mechanism — standard JSON-RPC WebSocket logs subscriptions versus Helius's Enhanced WebSocket versus their gRPC LaserStream — is a tier-and-cost question rather than an architectural one; ADR-004 records the current choice and its rationale. The Solana network itself is technically a separate dependency from Helius, because even when Helius is healthy our transactions still compete for inclusion in blocks against every other transaction on the network. Jupiter provides swap routing intelligence, taking the desired trade and producing an optimized transaction we can sign and submit. Telegram is our user interface, used for delivering alerts and accepting commands. Several data enrichment services, including DexScreener and RugCheck, provide additional context about tokens that helps our filters make better decisions. Finally, our own wallet is technically external to the system in the sense that the private key is held in environment variables and accessed only through cryptographic signing operations.

The architectural response to these dependencies is what we call the boundary defense approach. We do not let business logic talk directly to any external service. Instead, every external service is wrapped by an adapter that lives in the infrastructure layer. The adapter handles the messy reality of dealing with external services, including timeouts, retries, error translation, and rate limiting, and presents a clean interface to the rest of the system. When Helius changes their API or Jupiter rate limits us or Telegram has an outage, the impact is contained to the relevant adapter. The rest of the system is unaffected.

This approach has one significant cost. The adapter layer requires careful interface design before it can be used. We must think through what each adapter promises to its callers and what each adapter does when those promises cannot be kept. For a system this size, with five or six external dependencies, this upfront design work is justified by the consistency benefits and the centralized error handling. For a much smaller system, the boundary defense approach would be over-engineering, and direct calls would be acceptable. We are choosing it deliberately because the system has enough complexity to justify it.

---

## Part Three: The Eight Modules

The system inside our boundary is organized into eight modules. Each module has one reason to change, one clear responsibility, and clear interfaces with its neighbors. The modules are described below in roughly the order they appear in the data flow.

### The Infrastructure Layer

The infrastructure layer is the foundation of the system. It contains the adapters for all external services, including Helius for blockchain access, Jupiter for swap routing, Telegram for the user interface, and the various data enrichment services. It also contains shared infrastructure that other modules depend on, including the event bus that connects modules together, the clock abstraction that lets us control time for testing, and the data store that persists everything the system learns.

The reason this layer exists as its own module is that the axis of change for this code is "the realities of external services and their quirks," which is completely orthogonal to anything else in the system. If Helius changes their API, we update one adapter. If we decide to switch from Telegram to a web dashboard, we add a new interface adapter. If we discover that our retry logic is too aggressive and we are getting rate limited, we tune one place. The rest of the system is shielded from all of these concerns.

The interfaces this layer exposes to the rest of the system are intentionally narrow. The Helius adapter does not expose the full breadth of the Solana RPC API. It exposes only the specific operations our system needs, with types defined by us rather than imported from Helius's library. This narrowness is what makes the adapters replaceable. If we ever need to switch RPC providers, the surface area we have to reimplement is small and well-defined.

### The Token Detection Layer

The token detection layer subscribes to streams from the infrastructure layer and identifies when a new token has been launched on one of the platforms we monitor. Its output is a stream of events describing detected tokens. It does not filter, it does not enrich, it does not analyze. It answers the question "did something interesting just happen on chain" with a yes-and-here-are-the-basic-facts.

The reason this is its own module is that the axis of change is "what counts as a detection event." Over time we may add new launchpads, decide to monitor liquidity additions to existing pools, or detect graduations from Pump.fun to PumpSwap. All of these changes affect only this module. The detection layer's output type is small and stable, containing only the bare minimum needed to identify a token and start investigating it.

A subtle but important property of the detection layer is that it is the only place in the system that translates from the messy reality of Solana program logs into our clean internal types. The detection layer reads transaction signatures, parses program instruction data, and extracts the relevant fields. By the time a detection event reaches the rest of the system, it has been normalized into a shape that is consistent across all launchpads. A token detected on Pump.fun and a token detected on Raydium look the same to downstream modules.

### The Enrichment Layer

The enrichment layer takes a detected token and gathers the static information that defines the token's launch configuration: holder distribution, liquidity figures, contract security flags (mint and freeze authority status), creator allocation, and third-party risk signals. The output is an enriched candidate that strategies can evaluate. Behavioural data — what happens to the token in the seconds and minutes after launch, who buys, who sells, whether the creator transfers their allocation — is a sibling concern, captured by an activity-tracker module that subscribes to the same on-chain event stream the detection layer uses.

The reason enrichment is its own module is that the axis of change is "what static data we want to gather and from where." As we learn what data is most predictive, we add new sources or remove ones that prove unhelpful. Phase 1 ships with a single source: RugCheck's `/v1/tokens/<mint>/report` endpoint, which combines risk score, holder distribution, mint and freeze authority status, creator balance, and on-chain liquidity into one response. Additional sources slot in as new fields on `TokenWithFullContext`, each wrapped in its own `Result<Snapshot, FetchError>` so partial failures (one source down, others succeeded) are explicit rather than hidden.

The output type carries the full raw JSON of each source response alongside the parsed snapshot, so future analytical work can mine fields that weren't part of the initial parse. This matches the Phase 1 observability framing: capture rich data first, decide what's predictive from real data later.

Each external call is bounded by a per-source timeout and threaded with the parent shutdown signal so clean shutdown cancels in-flight requests. There is no scheduler or shared queue — concurrency is handled by Node's event loop and a small per-mint state map that holds each detected token until enrichment can act on it. At Pump.fun's launch rate the in-flight memory pressure is negligible.

Enrichment does not fire on detection. It fires on the first `TokenTradeObserved` event for a detected token, because third-party indexers like RugCheck only have something to report once on-chain activity has occurred. The detection event is used to *cache* the detected token in the per-mint state map; the first trade for that mint is what triggers the actual RugCheck call. If the call fails, the state returns to idle and is eligible to retry on the next trade after a short cooldown, again using the bus's own readiness signal rather than a wall-clock timer. Tokens that never produce an observable trade fall through to a `TokenAnalysisCompleted` event with an err snapshot at `TokenTrackingClosed`, preserving the one-event-per-detected-token invariant.

### The Activity Tracker

The activity tracker is enrichment's behavioural counterpart. Where enrichment captures the static configuration of a token at the moment of detection (mint authority, holder list, creator allocation), the activity tracker watches what happens to the token in the seconds and minutes after launch — every buy, every sell, every creator transfer, and the eventual graduation event when the bonding curve completes. Its output is a stream of `TokenTradeObserved` events per trade and one `TokenTrackingClosed` event when tracking ends for a given mint (either because the token graduated or because a max-age safety timeout fired).

The reason this is its own module is that the axis of change is "what behavioural signals matter and how we summarise them," which evolves independently of the static enrichment sources. The activity tracker does not call external services. It subscribes to the same Pump.fun program log stream the detection layer already consumes, parses the `TradeEvent` and `CompleteEvent` payloads emitted by the on-chain program, and routes matched events to per-mint state held in an in-memory map. State is dropped when tracking closes.

The activity tracker is the most stateful module in the system. Each detected token gets an entry in the tracking map, accumulates per-trade counts and trader identities, and is dismissed on a defined terminal condition. To handle the common case where a Pump.fun creator bundles a Create instruction and a Buy instruction into the same transaction — verified empirically to occur in roughly 45% of launches — the tracker also keeps a small bounded buffer of trades observed for mints we have not yet seen a detection for. When the corresponding `NewTokenLaunchDetected` event arrives, any matching buffered trades are replayed into the freshly created state record so the creator's initial buy is not silently dropped. The buffer has both a time-based age cap and a size cap to prevent unbounded growth.

The tracker uses a 30-minute max-age timeout as a safety bound on tokens that never graduate and never go inactive. This is a starting estimate and is expected to be tuned from operational data.

### The Strategy Layer

The strategy layer is where our trading intelligence lives. A strategy is a self-contained unit with its own filter rules, its own confidence scoring, its own position sizing logic, and its own exit rules. Each strategy receives enriched candidates and independently decides whether to act. The strategy layer is explicitly designed to host multiple strategies running in parallel, each maintaining its own performance metrics.

The reason this is its own module is that strategies are the thing that will change most often as we learn what works. We need to be able to add a new strategy, run it in shadow mode without affecting other strategies, measure its performance, and either promote it or kill it. This is impossible if strategy logic is tangled into other modules.

The multi-strategy architecture also serves a deeper purpose around safe experimentation. New ideas always start as new strategies running in paper mode alongside the production strategies. They are observed for weeks before being trusted with real money. This structured approach to evolution is what separates a system that improves over time from one that calcifies after launch.

The boundary between the strategy layer and the rest of the system is critical. Strategies receive enriched candidates and produce decisions. They do not access external services directly. They do not know how their decisions will be executed. They are pure transformations from input to output, which makes them easy to test in isolation and easy to reason about.

### The Execution Layer

The execution layer is what actually buys and sells. When a strategy decides to enter a position, the execution layer constructs the appropriate Solana transaction, simulates it to ensure it will succeed and that the token is not a honeypot, calculates an appropriate priority fee based on current network conditions, signs the transaction with our wallet, and submits it to the network. The same module handles exits when triggered by the position monitor.

The reason this is its own module is that execution is mechanism, not policy. It does not know why a trade is happening. It just knows how to execute trades reliably. The axis of change is "how Solana transactions are most reliably submitted," which evolves with the network itself but independently of our trading strategies.

The execution layer has two distinct implementations that can be swapped at startup based on configuration. The real executor constructs and submits actual Solana transactions. The paper executor records what trades would have happened without actually executing them, producing the same event outputs as the real executor so that downstream modules cannot tell the difference. This architectural separation between paper and real execution is what makes phase transitions safe. The strategies validated in paper mode are the exact same strategies that run with real money in later phases.

### The Position Monitor

Once we have entered a position, the position monitor watches it. The module tracks current price, peak price reached, time held, and any red flag signals such as the creator wallet selling tokens or liquidity being removed from the pool. It evaluates exit conditions on a continuous basis and triggers the execution layer when an exit should happen.

The reason this is its own module is that position monitoring is fundamentally different from token detection. Detection is about discovering new things in a high-throughput stream. Monitoring is about watching specific things we already care about, with low throughput per position but high importance per event. Conflating these two concerns would produce a confused module with conflicting performance characteristics.

The position monitor maintains a hot loop over all open positions, refreshing their state at intervals appropriate to their volatility. Newly opened positions are checked frequently because their early behavior is most informative. Older stable positions are checked less frequently to conserve resources. This is its own concern, separate from the detection of new tokens.

### The Interface Layer

The interface layer is how the user interacts with the system. For phase one this is a Telegram bot that delivers alerts and accepts commands. The interface layer subscribes to events from across the system and translates them into messages the user will see. It also publishes events when the user issues commands, allowing other modules to react.

The reason this is its own module is that the axis of change is "how the user interacts with the system," and that may evolve significantly later. If we ever add a web dashboard, a Chrome extension, or a CLI, those become additional interface modules running alongside Telegram. None of the rest of the system needs to change.

The Telegram interface specifically handles alert formatting, command parsing, rate limiting on outgoing messages to respect Telegram's API limits, and authentication of incoming commands to ensure only the bot owner can issue them. These concerns are local to the interface layer and do not leak into the rest of the system.

In Phase 1 the interface layer is outbound-only — it subscribes to `NewTokenLaunchDetected`, `TokenAnalysisCompleted`, and `TokenTrackingClosed` and forwards each as a formatted Telegram message to the whitelisted operator. The Telegram client uses HTML parse mode (escapes only `<`, `>`, `&`), respects Telegram's per-chat rate limit through grammY's `transformer-throttler` plugin, and silently absorbs send failures so that a Telegram outage cannot block the trading pipeline. A 403 response is logged with a clear remediation message because it indicates the operator has not yet started a conversation with the bot. Inbound command handling (pause, status, etc.) is deferred to a later phase.

---

## Part Four: How Modules Communicate

The seven modules described above do not call each other directly. Instead, they communicate through an event bus that lives in the infrastructure layer. Modules publish events describing things that have happened, and other modules subscribe to the events they care about. This is the event-driven architecture pattern, and it is the central organizing principle of how data flows through the system.

The motivation for the event bus is loose coupling. In a direct-call architecture, the detection layer would have to know that the enrichment layer exists in order to hand candidates to it. The enrichment layer would have to know about the strategy layer. Each module becomes coupled to its downstream neighbor, and adding a new consumer of any data requires modifying the producing module. With an event bus, each module knows only about events. The detection layer publishes a "new token launched" event without caring who is listening. Enrichment subscribes to that event because it cares about new tokens. If we later want to add a debug logger that records every detected token, we add a new subscriber without modifying anything else.

A second benefit of the event-driven approach is observability. Every interesting thing that happens in the system flows through the event bus. By tapping into the bus, we can build observers that record activity, measure performance, replay history, or debug issues. The system gains a natural audit trail without explicit instrumentation in each module.

The events in our system are named in the descriptive imperative style that makes their meaning self-evident from the name alone. We use verbs and clear descriptions rather than terse domain jargon. The full event catalog is described in the next section, but the principle is that someone reading the event names should be able to understand what each one represents without needing additional documentation.

The event bus is implemented asynchronously. When a module publishes an event, the publication does not block on subscribers processing it. Subscribers handle events on their own time, in parallel with each other when possible. This is the only sensible choice for a system that must remain responsive while many things happen concurrently. A synchronous bus would mean that a slow enrichment operation could block the detection layer from processing the next token. The asynchronous design ensures that one slow component does not stall the entire pipeline.

---

## Part Five: The Event Catalog

The system has a well-defined set of events that flow through the bus. Each event has a name that describes what happened, a payload type that contains the relevant data, and a documented set of subscribers. New events are added by following the same pattern, and the catalog is the source of truth for what is happening in the system.

When the Helius adapter receives a program-log notification from its Pump.fun WebSocket subscription, it publishes a `RawProgramLogReceived` event without inspecting the payload. The value is a `ProgramLogEvent` containing the transaction signature, the slot, the array of log lines, and the transaction error (null on success). The detection layer is the sole subscriber. This event is the boundary between Solana's wire format and the project's internal types — nothing upstream of it speaks our shapes, and nothing downstream of the detection layer sees raw logs.

When a new token is detected on any monitored launchpad, the detection layer publishes a `NewTokenLaunchDetected` event. The payload is a `DetectedToken` value containing the token's mint address, the launchpad it was launched on, the creator wallet address, the initial liquidity amount in SOL, the timestamp of detection, and a unique internal identifier for tracking. The enrichment layer subscribes to this event to cache the detected token in its per-mint state map, but does not yet act — see the enrichment layer description in Part Three for the trigger semantics. The activity tracker subscribes to start watching the token's on-chain trades. The interface layer subscribes to forward each detection to the operator as a Telegram notification. The data store also subscribes to record every detection.

When the enrichment layer completes its analysis of a detected token, it publishes a `TokenAnalysisCompleted` event. The payload is a `TokenWithFullContext` value containing the original detected token plus all the gathered data. Each external source is represented as a per-field `Result`, so a failed source is carried inside the payload as its `err` variant rather than published as a separate failure event. Every detected token produces exactly one `TokenAnalysisCompleted` event, including the case where every source failed — this invariant is what lets the strategy layer assume there is always a decision to make. The strategy layer subscribes to this event to evaluate the candidate. The interface layer subscribes to forward the analysis summary to the operator. The data store subscribes to persist the enriched candidate for later analysis.

When the activity tracker observes a Pump.fun buy or sell for a token it is currently tracking, it publishes a `TokenTradeObserved` event. The payload is a `TokenTradeObserved` value containing the token's internal ID and mint, the trader's wallet, whether the trade was a buy or a sell, the SOL and token amounts, the bonding curve's virtual reserves at the time of the trade, the slot, the transaction signature, the observation timestamp, and the Pump.fun-emitted timestamp from the on-chain event. The enrichment layer subscribes to fire its analysis on the first observed trade for a detected token, and to retry after cooldown if a prior attempt failed. The data store subscribes to persist every trade. The strategy layer may subscribe to act on behavioural signals.

When the activity tracker stops watching a token — either because the bonding curve completed (graduation) or because the max-age safety timeout fired — it publishes a `TokenTrackingClosed` event. The payload contains aggregate counts (trade count, buy count, sell count, unique traders, whether the creator traded during tracking) and the slots of the first and last observed trades. The interface layer subscribes to forward the closing summary to the operator. The data store subscribes to persist it alongside the per-trade records. The enrichment layer subscribes to publish a final `TokenAnalysisCompleted` event with an err snapshot for any cached token that never produced a successful RugCheck call. The reason field discriminates between `'graduated'` and `'timeout'` so post-hoc analysis can separate the two failure modes.

When a strategy evaluates a candidate, it publishes a `StrategyDecisionRecorded` event regardless of the decision. The payload is a `StrategyEvaluationResult` value containing the strategy identifier, the candidate it evaluated, and the decision made. This event captures all decisions, including the many "pass" decisions that do not result in trades. The data store subscribes to record every decision for later analysis. Tracking pass decisions is critical because the negative space is informative. We learn as much from understanding why strategies declined to trade as from understanding their entries.

When a strategy specifically decides to enter a position, it publishes a `BuyOrderRequested` event. The payload is an `EntryRequest` value containing the candidate, the proposed position size, the slippage tolerance, and the exit rules to apply. The execution layer subscribes to this event. Note that this is a separate event from `StrategyDecisionRecorded` even though it represents a subset of decisions. Subscribers that only care about entry requests should not have to filter through every decision.

When the execution layer successfully completes an entry, it publishes a `BuyOrderFilled` event. The payload is an `OpenPosition` value containing the original entry request, the actual entry price achieved, the actual amount of tokens received, the transaction signature for audit purposes, and the entry timestamp. The position monitor subscribes to this event to begin watching the new position. The interface layer subscribes to inform the user. The data store subscribes for persistence.

When the execution layer cannot complete an entry, either because simulation failed or because the transaction failed to land, it publishes a `BuyOrderRejected` event with a `RejectedEntryReport` payload describing the reason. These rejections are informative. A strategy that produces many entry requests that get rejected during execution is a strategy with a problem we need to investigate.

While a position is open, the position monitor publishes periodic `PositionUpdate` events containing current price, peak price reached, and unrealized profit or loss. These events are throttled to reasonable frequencies and are primarily for the data store and any monitoring dashboards. The interface layer typically does not subscribe to these because they would be too noisy.

When an exit condition is met, the position monitor publishes a `SellOrderTriggered` event. The payload is an `ExitRequest` value containing the position to exit and the trigger that fired. The execution layer subscribes to this event. The interface layer also subscribes to inform the user that an exit is imminent.

When the execution layer completes an exit, it publishes a `SellOrderFilled` event. The payload is a `ClosedPosition` value containing the full record of the position from entry through exit, including realized profit or loss. This is the event that closes the lifecycle. The data store subscribes for persistence. The interface layer subscribes to inform the user. Performance tracking modules subscribe to update strategy performance metrics.

If an exit cannot be completed, the execution layer publishes a `SellOrderFailed` event with details about the failure. This is a critical event because a failed exit means we still hold a position that should have been closed. The interface layer subscribes urgently to alert the user that manual intervention may be needed.

---

## Part Six: The Lifecycle Types

The events described above carry payloads of specific types. Each type represents a specific stage in the lifecycle of a candidate, and the type system enforces that we cannot accidentally pass a value from one stage to a function expecting another stage. This is the practice of making invalid states unrepresentable, and it is the primary defense against a whole class of bugs that plague systems with looser type discipline.

A `DetectedToken` represents a token at the moment of detection. It contains only the information available from the launch event itself: the mint address, the launchpad, the creator wallet, the initial liquidity, the detection timestamp, and an internal identifier. It does not contain holder counts or transaction patterns or anything else that requires additional analysis.

A `TokenWithFullContext` represents a detected token after enrichment. It embeds the original `DetectedToken` and adds one field per external source the enrichment layer consulted, each wrapped in `Result<Snapshot, FetchError>`. Phase 1 has one source field — `rugcheck: Result<RugCheckSnapshot, RugCheckFetchError>` — and additional sources slot in as additional fields with their own typed snapshot and error variants. Because each source is independently fallible, strategies can pattern match on which sources succeeded and choose how strict they want to be about requiring complete data.

A `StrategyEvaluationResult` represents a strategy's decision about a candidate. The decision itself is a discriminated union with three variants. A `Pass` variant means the strategy declines this candidate and includes the reason for the pass. A `Watch` variant means the strategy is not confident enough to enter but wants to keep observing. An `Enter` variant means the strategy wants to take a position and includes the proposed size and exit rules. This discriminated union pattern eliminates the possibility of inconsistent state, where for example an "enter" decision lacks a position size.

An `OpenPosition` represents a position that has been entered and is currently held. It contains the entry request that triggered it, the actual execution details, and a continuously updated record of the position's behavior including current price and peak price reached. The position is the unit that the position monitor watches.

A `ClosedPosition` represents a position that has been exited. It contains the full history from entry through exit, including the exit price achieved, the realized profit or loss, the exit reason, and the duration held. Closed positions are immutable historical records used for strategy performance evaluation.

A `RejectedEntryReport` captures a negative outcome from the execution layer that we still want to record for analysis. Even when execution rejects an entry, we capture the fact and the reason, because patterns in failures are informative.

The transitions between these types happen in specific modules. The detection layer produces `DetectedToken`. The enrichment layer transforms it into `TokenWithFullContext`. The strategy layer evaluates it and produces `StrategyEvaluationResult`. If the evaluation is `Enter`, the execution layer attempts to produce an `OpenPosition`. The position monitor eventually triggers an exit, and the execution layer closes the position into a `ClosedPosition`. Each transition is explicit and visible in the type signatures.

---

## Part Seven: Data Flow Through the System

To make all of this concrete, let us trace what happens when a new token launches on Pump.fun. This walkthrough connects the modules, events, and types described above into a single coherent picture.

The infrastructure layer's Helius adapter is maintaining a WebSocket subscription to the Solana network, listening for log notifications from the Pump.fun program. Each time the program emits a transaction's logs, the adapter receives a notification containing the transaction signature, slot, and the array of log lines. The adapter does not interpret these logs. It publishes them on the event bus as a `RawProgramLogReceived` event, carrying exactly the payload it received from the network. The vast majority of these events are not new-token launches — they are buys, sells, and other interactions with existing tokens on the launchpad. Filtering them out is not the adapter's job.

The detection layer subscribes to `RawProgramLogReceived`. For each event, it scans the log lines for the marker that identifies a token-creation instruction (`Program log: Instruction: CreateV2` or `Program log: Instruction: Create`) and, when it finds one, decodes the following `Program data:` line — a base64-encoded borsh payload emitted by the Pump.fun program — into a `DetectedToken` value. If the marker is absent or the decode fails, the event is dropped silently. When a token is successfully decoded, the detection layer publishes a `NewTokenLaunchDetected` event with the `DetectedToken` as its payload. This is the only place in the system where messy on-chain log strings are translated into the project's clean internal types.

Several modules are subscribed to `NewTokenLaunchDetected`. The data store records the detection for our analytical archive. The detection layer itself emits a structured log entry at info level for the same event so operations have an audit trail without querying the data store. The activity tracker creates an entry in its per-mint state map and begins watching the Pump.fun program log stream for trades on this mint. The enrichment layer also creates an entry in its own per-mint state map, but does not yet make any external call — see Part Three for why.

The first time a buyer (often the creator's own bundled buy) trades against the new bonding curve, the activity tracker parses the Pump.fun `TradeEvent` and publishes a `TokenTradeObserved` event. This is enrichment's trigger. The enrichment layer looks up its cached state for the mint, finds it idle, transitions it to in-flight, and asks RugCheck for the token's report. If the report comes back with the expected fields, the enrichment layer publishes a `TokenAnalysisCompleted` event whose `rugcheck` field is an `ok` Result. If the call fails — RugCheck commonly returns HTTP 400 for tokens whose on-chain state has not yet propagated to its indexer — the state returns to idle and the next observed trade, after a small cooldown, is eligible to retry. ADR-006 captures the empirical evidence behind this design and the alternatives considered.

Phase 1 ships with a single enrichment source. As we add more sources in later phases they can be queried in parallel, similar to how `Future.wait` parallelizes operations in Dart, each wrapped in its own `Result` so partial failures (one source down, others succeeded) are explicit rather than hidden. The assembly step that produces a `TokenWithFullContext` works identically whether one source or many succeed.

If the activity tracker eventually closes its tracking for the mint — either because the bonding curve completed (graduation) or because the max-age safety timeout fired — and the enrichment layer has not yet successfully published anything for that mint, the enrichment layer publishes a `TokenAnalysisCompleted` event whose `rugcheck` field is an `err` Result. This preserves the one-event-per-detected-token guarantee the strategy layer relies on.

The strategy layer is subscribed to `TokenAnalysisCompleted`. It receives the enriched candidate and routes it to all active strategies. Each strategy independently evaluates it. Most strategies will return `Pass` decisions because the system is designed for selectivity. Each pass is a `StrategyDecisionRecorded` event that the data store captures for later analysis.

Occasionally a strategy returns an `Enter` decision. This produces a `StrategyDecisionRecorded` event but also a more specific `BuyOrderRequested` event that the execution layer subscribes to.

The execution layer receives the buy order request. It asks Jupiter for the best route to swap SOL into the target token. It receives back a transaction template. Before signing, it simulates the transaction to verify it will succeed and that the token is not a honeypot. If simulation fails, it publishes a `BuyOrderRejected` event and stops there. If simulation succeeds, it calculates a priority fee based on current network congestion, signs the transaction with our wallet, and submits it to the network.

The transaction lands or fails to land. If it lands, the execution layer queries the transaction result, extracts the actual entry price and amount received, constructs an `OpenPosition`, and publishes a `BuyOrderFilled` event. The position monitor subscribes to this event and begins watching the new position. The interface layer subscribes and sends a Telegram message to the user. The data store subscribes and persists the position.

The position monitor maintains its hot loop over all open positions. It periodically queries the current price of each held token, updates the peak price tracking, and checks each exit condition. If any exit condition fires, it publishes a `SellOrderTriggered` event with the relevant exit request.

The execution layer receives the sell trigger. It constructs the appropriate exit transaction through Jupiter, signs it, and submits it. On success, it publishes a `SellOrderFilled` event with the closed position details. The data store records the closed position. The interface layer notifies the user. The strategy that originally triggered the entry has its performance metrics updated based on the realized outcome.

Throughout this entire flow, no module reaches back upstream to ask its producer for more information. Information flows in one direction. Each module receives what it needs, transforms it according to its responsibility, and produces output for the next stage. This is what loose coupling looks like in practice.

---

## Part Eight: The Four Key Refinements

The architecture described above incorporates four specific design choices that elevate it from a basic working system to one that can evolve safely over time. These choices were made deliberately and are documented here so they can be defended when challenged.

The first is the event-driven communication model. The benefits and reasoning have been described in part four. The cost is that the data flow is not visible in any single piece of code. You have to know the event catalog and the subscribers to follow what happens. This is mitigated by maintaining the event catalog as a living document and by descriptive event naming that makes the flow obvious from the names alone.

The second is the use of distinct lifecycle types for each stage of a candidate's journey. The benefits are compile-time prevention of invalid states and self-documenting code where types tell the story. The cost is more type definitions and more transformation code between stages. This is a worthwhile cost because the bugs prevented are severe. Mistaking a partially-enriched candidate for a fully-enriched one in a strategy's decision logic could produce a bad trade.

The third is the architectural separation between paper trading and real trading. The execution layer has two implementations that satisfy the same interface, with the choice made at startup based on configuration. The benefits are safe phase transitions and the ability to run new strategies in shadow mode alongside production strategies. The cost is the discipline of keeping the two executors behaviorally consistent in everything except whether they actually submit transactions. This consistency is enforced through shared code paths everywhere except the actual signing-and-submitting step.

The fourth is the abstraction of time as an injected dependency. The system uses a `Clock` interface rather than calling system time directly. The benefit is that we can test time-dependent behavior deterministically by injecting a mock clock that we control. This includes scenarios like "what happens if a position is held for thirty-five minutes and the price drops twenty-five percent." Without injected time, these scenarios cannot be tested without actually waiting thirty-five minutes. The cost is minor: one more dependency injection at startup and one more interface to remember to use. This is paid for many times over in testability.

---

## Part Nine: What This Architecture Is Not

To prevent future drift, it is worth being explicit about what the architecture deliberately does not include and why.

The system is not designed for distributed deployment. It runs as a single Node.js process on a single machine. It does not use Kafka or RabbitMQ or any external message queue. The event bus is in-process. This is a deliberate choice based on the system's actual requirements. We are building for one user, with one bot, on one server. Distributed event systems would be significant complexity for problems we do not have. If the system ever needs to scale beyond one machine, the architecture allows it because the in-process bus could be replaced with an external one. But we will not preemptively pay that cost.

The system does not include a plugin architecture for external strategy contributors. All strategies are first-party code maintained in this repository. Adding the infrastructure to support third-party plugins would compromise security and add complexity. If you want a new strategy, you write it in this codebase and review it before deployment.

The system is not multi-chain. It runs only on Solana. The architecture would allow a chain abstraction layer if we ever needed it, but adding that abstraction now would add complexity without benefit. Keep it simple until the requirement is real.

The system does not implement its own indexing of historical blockchain data. We use Helius and other services for the data we need. Building our own indexer would be a project comparable in size to the entire bot, and the existing services are sufficient.

The system does not have a complex permission model or multi-user support. There is one user, the bot owner. Authentication for the Telegram interface checks a single Telegram user ID. There are no roles, no sharing, no team features.

These omissions are not gaps. They are intentional decisions to keep the system focused on its actual purpose.

---

## Part Ten: How This Document Relates to Others

This architecture document describes the system at a high level. For details on specific topics, refer to the other documents in this project.

The engineering standards document describes how we write code, including TypeScript conventions, error handling patterns, security requirements, testing approach, and documentation expectations. It is the answer to "what counts as good code in this project."

The architecture decision records, in the `adr` subfolder of `docs`, capture individual decisions in detail. Each ADR explains one decision, the alternatives considered, and the reasoning. New decisions throughout the project's life become new ADRs.

The CLAUDE.md file at the project root is the orientation document for AI assistants working on the project. It summarizes the project, points to this and other documents, and captures preferences that should apply to every interaction.

The project setup guide covers practical concerns: tools to install, environment configuration, directory structure, and how to run the project.

When making architectural changes, this document is the one that gets updated, and the corresponding ADR is added. When making coding-style changes, the engineering standards document is updated. Keep these documents living. Stale architecture documentation is worse than none, because it actively misleads.

---

## Closing Note

The architecture described here is the result of careful reasoning about what we are actually trying to build. It is not the only valid architecture for a Solana trading bot, and it is not the architecture you would build for a different problem. It is specifically designed for a personal selectivity-and-discipline bot that prioritizes safe evolution over raw speed.

If you are picking up this project after time away, trust the document. The reasoning behind each decision was captured because the reasoning matters. If you find yourself wanting to deviate from the architecture, do so deliberately. Update this document or write a new ADR explaining the change. The goal is a system that remains comprehensible and maintainable over time, and that goal is served by keeping the documentation honest.
