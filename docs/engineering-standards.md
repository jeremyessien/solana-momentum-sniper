# Engineering Standards

## Solana Momentum Sniper Bot

This document defines how we write code in this project. Where the architecture document tells us what to build, this document tells us how to build it. Every coding decision in the project should be traceable back to the principles in this document. When you encounter a situation the document does not directly address, reason from the principles to the right answer, then add the new rule to the document so the next person does not face the same ambiguity.

The document is organized around principles, with concrete practices and examples flowing from each. The principles are not arbitrary. They reflect real lessons from how production-grade systems either succeed or fail. Read each principle along with its reasoning, not just the rules.

---

## Principle One: Question Assumptions

The most dangerous thing in any codebase is the unexamined assumption. A developer assumes a function always succeeds, so they do not handle the failure case. A developer assumes data has a particular shape, so they reach into it without checking. A developer assumes a specific ordering of events, so they do not handle out-of-order arrival. Each of these assumptions becomes a bug the moment reality diverges from expectation.

The discipline that defends against this is to surface assumptions explicitly rather than letting them stay hidden in the code. This applies in two directions. When writing code, ask what you are assuming and either verify the assumption with a check or document why the assumption is safe. When reading code, ask what assumptions are baked into it and whether they hold under all conditions you can imagine.

In practice, this means several specific things in our codebase. When a function takes input from outside our system, the function validates the input rather than trusting it. The infrastructure layer adapters are particularly responsible for this, because they are where untrusted external data crosses the boundary into our trusted internal logic. When a piece of code makes a non-obvious assumption, a comment explains why the assumption is safe. When a code review or AI assistant generates code, questions are asked before assumptions are made. If a requirement is ambiguous, the response is to ask for clarification rather than to guess.

This principle also shapes how we work with Claude Code. Claude Code should be instructed to ask clarifying questions when a request is ambiguous, rather than making its best guess and proceeding. When a generated piece of code makes an assumption, that assumption should be visible in a comment so it can be reviewed.

---

## Principle Two: Apply Engineering Discipline With Judgment

DRY, SOLID, and other classical engineering principles are tools, not commandments. They exist to solve specific problems, and applying them mechanically without understanding the problem they solve produces worse code, not better.

DRY, the principle that code should not be duplicated, is fundamentally about avoiding situations where a logical change requires multiple synchronized edits. Two pieces of code that look identical but represent different concepts should not be merged just because they look the same. The question to ask is whether they will always change together. If they will, deduplicate them. If they might evolve in different directions, leave them separate even though they currently look the same. Premature deduplication creates fake abstractions that distort the system.

SOLID similarly needs careful interpretation. The single responsibility principle is best read as "a module should have one reason to change," not "a module should do one tiny thing." Our seven modules in the architecture each have exactly one reason to change, which is why they are the right boundaries. The open-closed principle is about being able to extend behavior without modifying existing code, which our event-driven architecture supports naturally. The Liskov substitution principle is about ensuring that implementations behave consistently with their interfaces, which we enforce through careful interface design. The interface segregation principle reminds us that interfaces should be narrow, exposing only what callers need, which is why our infrastructure adapters do not expose the full breadth of external APIs. The dependency inversion principle tells us to depend on abstractions rather than concretions, which is why the rest of the system depends on adapter interfaces rather than directly on Helius or Jupiter.

These principles all apply in our codebase, but they apply with judgment. When a SOLID rule produces awkward code, it is worth asking whether the rule is being misapplied rather than blindly contorting the code to fit. The principles serve the code, not the other way around.

---

## Principle Three: Resist Overengineering

Complexity has a cost, and that cost compounds over time. Code that is more complex than it needs to be takes longer to read, longer to modify, and longer to debug. Unnecessary abstractions become barriers between you and the actual behavior of the system. Premature flexibility creates dead code paths that nobody understands.

The discipline that defends against overengineering is to add complexity only when it solves a real problem you can name. Not a hypothetical future problem, but a real present one. When you find yourself writing infrastructure for situations that have not happened yet, ask whether the infrastructure is justified by what we know today.

The four refinements we adopted in our architecture all pass this test. The event bus solves the real problem of needing observers without modifying core modules. Lifecycle types solve the real problem of preventing invalid state combinations. Paper-versus-real executor separation solves the real problem of making phase transitions safe. Clock injection solves the real problem of testing time-dependent behavior. None of them are pattern-cargo-culting.

Some specific things this principle rules out for our project. We will not build a distributed event system because we are running on one machine. We will not build a plugin architecture because there are no third-party contributors. We will not implement a custom configuration framework when environment variables and a small config file are sufficient. We will not abstract over multiple databases when we are using one database. We will not build telemetry infrastructure beyond what is genuinely needed for observability. Each of these would be valuable in a much larger system. None of them are valuable in ours.

A useful test when you are tempted to add complexity is to ask whether removing the complexity would break a feature we actually use today. If the answer is no, the complexity is probably not justified yet.

---

## Principle Four: Write Modern Idiomatic TypeScript

The TypeScript ecosystem has evolved significantly over the past several years, and there are practices that were standard in 2020 that we should not adopt today. We write modern TypeScript that takes full advantage of the type system and the language's expressive features.

The most important practice is using discriminated unions for state representation. When a piece of state can be in one of several distinct configurations, model it as a union of types where each variant has a literal discriminant field. This is the same pattern as sealed classes in Dart, and it serves the same purpose: it makes invalid states unrepresentable and forces every consumer of the type to handle every variant. For example, our `StrategyEvaluationResult` is a union of `Pass`, `Watch`, and `Enter` variants, where each variant has its own appropriate fields. There is no single struct with optional fields that might or might not be set depending on which case applies.

A closely related practice is exhaustive pattern matching. When you switch over a discriminated union, you should handle every variant explicitly, and the compiler should tell you when you have missed one. TypeScript supports this through the never-type pattern, where the default case of a switch is typed as never to force exhaustive handling. We will use this pattern wherever we discriminate over unions.

We avoid the any type. When we genuinely do not know what type something is, we use unknown, which forces explicit narrowing before use. The any type silently disables type checking and is the source of many bugs. The unknown type preserves type safety while acknowledging that we have not yet narrowed the value.

We avoid the non-null assertion operator, which is the exclamation mark in TypeScript. This is the equivalent of the bang operator in Dart that you correctly avoid. The exclamation mark tells the compiler to trust you that something is not null without actually checking. Every use of the exclamation mark is a place where we have decided to risk a runtime null reference error rather than handle the null case properly. Instead of asserting non-nullness, we use guard clauses, optional chaining, or default values to handle nullable cases explicitly.

We use readonly extensively. When a value should not be mutated, we mark it as readonly so the compiler enforces immutability. This includes function parameters that are passed by reference but not meant to be modified, fields on objects that should be set once at construction, and arrays that should not be appended to. Immutability is a powerful tool for reasoning about code, because once you know a value cannot change, you can make stronger guarantees about behavior.

We prefer named exports over default exports. Default exports allow callers to rename the imported symbol arbitrarily, which makes refactoring harder and makes the codebase harder to navigate. Named exports preserve consistency in how things are referenced across the codebase.

We use ES modules rather than CommonJS. Our TypeScript configuration will target modern Node.js with native ES module support. The transition from CommonJS is largely complete in the ecosystem, and starting with ES modules avoids future migration pain.

We use const assertions for literal types. When defining a constant that should be narrowed to its literal value rather than widened to its general type, we use the as const syntax. This is particularly useful for configuration objects and discriminant values.

We treat type errors as bugs. The TypeScript compiler is configured in strict mode, including all the strict flags. When the compiler complains, we fix the actual issue rather than suppressing the warning. The compiler is one of the best tools we have for catching bugs early, and ignoring it defeats the purpose.

---

## Principle Five: Treat Security As Architecture

Security in a system that handles money is not a feature to add later. It is an architectural concern that affects design throughout the system. Every decision should be evaluated for its security implications.

The most important security boundary is the wallet. Our trading wallet holds funds that the bot can spend, and any code path that can sign a transaction is a potential attack surface. The discipline we follow is that the private key is loaded from environment variables once at startup and held only by the wallet adapter in the infrastructure layer. The key is never logged, never serialized, never passed to other modules, and never accessible through any interface other than cryptographic signing operations. The rest of the system requests signatures by sending the wallet adapter a transaction to sign, and receives back a signed transaction. The key itself does not leave the adapter's memory.

A related discipline is hard spending limits enforced at the lowest possible level. The execution layer has hard-coded maximum trade sizes that cannot be exceeded regardless of what any strategy decides. If a bug in a strategy somehow proposes a position size larger than the limit, the execution layer rejects it. This is defense in depth. We do not assume strategies will always behave correctly. We design the execution layer to be a backstop.

Configuration values that affect spending are bounded. Priority fees, slippage tolerances, position sizes, and similar values all have sanity limits. If a bug or a typo causes one of these to be set to an absurd value, the execution layer rejects rather than honors the absurdity. This protects against both code bugs and configuration mistakes.

External inputs are treated as untrusted until validated. Data from Helius, from Jupiter, from any other external service might be malformed, manipulated, or unexpected. The infrastructure layer validates all external data before it enters our internal types. Schema validation libraries like Zod are used at adapter boundaries to enforce the shape we expect.

The Telegram interface authenticates incoming commands. We check the Telegram user ID against a whitelist of permitted users. Any command from any other user is rejected. This prevents an attacker who learns the bot's existence from sending commands to it.

Logs do not contain sensitive data. Private keys obviously do not appear in logs, but we also avoid logging full wallet addresses, full transaction signatures in some contexts, exact position sizes that could expose strategy patterns to anyone who reads the logs, and other potentially sensitive information. When we need to log something for debugging, we log a truncated or hashed version that is informative without being sensitive.

Dependencies are audited before being added. Every npm package we install is a piece of code we are running. We use packages from reputable sources, prefer packages with active maintenance and a healthy community, and avoid pulling in dependencies casually. We also pin specific versions in our lock file rather than allowing version ranges, so the code we tested is the code we ship.

Network traffic uses TLS. Every external service we connect to is over HTTPS or a similarly encrypted protocol. We do not disable certificate validation. We do not use HTTP for anything that matters.

These practices are baseline. They are what every system handling money should do. The discipline is to apply them consistently rather than treating them as nice-to-haves that can be skipped under deadline pressure.

---

## Principle Six: Logs Are Tools, Not Outputs

Logs serve two purposes. They help us debug problems when they happen, and they create an audit trail of what the system did. They are not output for users to consume, and they are not a way to communicate with the operator. The interface layer is for communication. Logs are for engineering.

We use structured logging with severity levels. Each log entry is a structured record with a timestamp, a level, a message, and any relevant context fields. The levels are debug, info, warn, and error, with each level reserved for specific kinds of information.

Debug level captures detailed internal state useful during development and investigation. Specific values, intermediate computations, branch decisions, and similar low-level information goes here. Debug logs are suppressed in production by default but can be enabled when investigating an issue.

Info level captures notable events that happen during normal operation. New tokens detected, strategies firing, positions opening and closing, and other significant occurrences belong here. Info logs are enabled in production as the default level.

Warn level captures unexpected but recoverable situations. An external service responding slowly, a retry succeeding after initial failure, a candidate failing some enrichment but proceeding with partial data. Warn logs indicate that something is not quite right but the system is handling it.

Error level captures failures that prevent normal operation. A required external service being unreachable, a transaction failing to land, a strategy crashing during evaluation. Error logs indicate situations that may need investigation or intervention.

The fields in a log entry follow a consistent schema. Every entry has a timestamp, a level, and a message. Beyond those, structured fields capture the context: which module produced the log, which event was being processed, which token or position is relevant, and any other dimensions we might want to filter or aggregate by. Structured fields are vastly more useful than free-text concatenation because they can be queried mechanically.

In production, logs are written to a file with rotation, not to standard output. The file is rotated daily and old files are compressed and retained for a configurable period. Log files are not committed to version control and are excluded from any deployment artifact.

Sensitive data does not appear in logs. This was already covered in the security principle but bears repeating. Private keys, complete wallet addresses, full transaction signatures in audit-sensitive contexts, exact dollar amounts, and other potentially sensitive information are either omitted, truncated, or hashed before being logged.

When debugging an issue, the question to ask is whether the existing logs answered the question. If they did not, the missing information is added so the next time the issue occurs we have what we need. Over time the logging becomes a record of every difficult debugging session, and the system becomes progressively easier to operate.

---

## Principle Seven: Errors Are Values, Not Exceptions

In production code that handles money, we cannot afford the laziness of unhandled exceptions. An exception thrown in a corner of the code that nobody handles propagates up the call stack until something catches it, often crashing the system or leaving it in an inconsistent state. The defense against this is to treat errors as values that flow through the code explicitly, the same way successful values flow through the code.

The pattern we use is the Result type, which is a discriminated union representing either success with a value or failure with an error. Every operation that can fail returns a Result rather than throwing. Callers must explicitly handle both the success and failure cases through pattern matching, because the compiler will not let them ignore one or the other.

This is the same pattern used in modern Rust, in modern Dart, in modern functional codebases. It is not a TypeScript-specific idiom, it is a software engineering idiom that TypeScript supports well through its type system. The benefit is that errors become visible in type signatures. When you read a function's return type, you can see immediately whether it can fail and what kind of errors it can produce. This is dramatically more useful than the alternative, where the only way to know what exceptions a function might throw is to read its implementation, which itself depends on the implementations of everything it calls.

The Result pattern requires discipline at the boundary. Code that interacts with libraries that throw exceptions must catch those exceptions and translate them into Result values before they enter our internal logic. The infrastructure layer adapters are the natural place for this translation. Inside the system, exceptions should never occur during normal operation, because all the operations that could fail return Results explicitly.

The error variant of a Result carries enough information to handle the error appropriately. We define error types that are themselves discriminated unions, with each variant representing a specific kind of failure. This lets callers pattern match on the error type and handle different failures differently. A network timeout is handled differently from a malformed response, which is handled differently from an authentication failure.

When pattern matching on a Result, we explicitly handle both cases. We do not unwrap blindly. We do not assume success. The compiler enforces this through the discriminated union pattern, and we rely on the compiler to keep us honest.

There are a small number of cases where exceptions are still appropriate. Programmer errors that should never happen at runtime, such as a violated invariant inside a module, can throw because they indicate bugs that need to be fixed rather than handled. The boundary between exceptions and Results is roughly: external failures that the program might recover from are Results, internal failures that indicate bugs are exceptions. The boundary is enforced by convention and code review, not by language features.

---

## Principle Eight: Stay Current On Best Practices

You have stated that you do not know the TypeScript and Node.js ecosystem deeply yet. This document and the architecture document together represent best practices as of when they were written, but the ecosystem evolves. Practices that are current today will be replaced by better practices in a year or two.

The discipline this calls for is to flag explicitly when a recommendation reflects modern best practice rather than just convention. When there are multiple valid approaches, the reasoning behind the chosen one should be documented. When the ecosystem moves on, the documentation should be updated to reflect the new practice.

For our specific stack, the current best practices include using ES modules rather than CommonJS, using TypeScript strict mode with all strict flags enabled, using async/await throughout rather than raw Promises or callback patterns, using runtime validation libraries like Zod at boundaries where untrusted data enters the system, using a modern test runner like Vitest rather than older alternatives, using a modern linter like Biome or ESLint with sensible rules, and using a build setup that produces sourcemaps so debugging is straightforward.

We also follow the Node.js ecosystem's conventions for project structure. The package.json file declares dependencies and scripts. The tsconfig.json file declares TypeScript compiler options. Source code lives in a src directory. Tests live alongside the code they test or in a parallel directory structure. Configuration is loaded from environment variables with type-safe access through a dedicated configuration module.

When in doubt about the current state of a practice, we check authoritative sources before committing to an approach. The TypeScript documentation, the Node.js documentation, and the documentation of any libraries we use are the primary references. Blog posts and tutorials are useful for context but should not be the sole source for important decisions.

---

## Principle Nine: Tests Are Required, Not Optional

This is the principle I am adding to your original list, because in reviewing the original nine I noticed testing was not addressed and a system handling real money cannot ship untested.

The discipline of testing is not about coverage percentages or test counts. It is about confidence. Every piece of important behavior in the system should have a test that proves it works. When a bug is found, a test is added that would have caught it. When a behavior is changed, the corresponding test is updated. The tests become a living specification of what the system does, and they prevent regressions when changes are made.

We write three categories of tests, each serving a different purpose.

Unit tests cover individual functions and modules in isolation. They are fast, deterministic, and focused on one behavior at a time. They use mocks for external dependencies, including the clock and any infrastructure adapters. The strategy layer in particular benefits from heavy unit testing, because strategies are pure transformations from input to output and can be tested by feeding them constructed candidates and verifying their decisions.

Integration tests cover the interaction between modules through the event bus. They verify that publishing one event causes the right downstream events to be published, that the data flows correctly through the system, and that error cases are handled appropriately. Integration tests use the real event bus implementation and the real module implementations, with only the infrastructure adapters mocked.

End-to-end tests cover the full system with all real components except the actual blockchain. The blockchain is replaced by a mock that emits scripted events, allowing us to play scenarios through the system and verify the entire pipeline behaves correctly. End-to-end tests are slower and more expensive to maintain than unit or integration tests, but they catch issues that the smaller-scoped tests miss.

The clock injection refinement we adopted in the architecture is what makes time-dependent tests practical. Tests inject a mock clock that they advance programmatically, allowing scenarios like "the position has been held for 35 minutes and the price has dropped 25 percent" to be tested deterministically.

We aim for high test coverage but not at the cost of writing meaningless tests. A test that asserts the same thing as the implementation under test is not a test, it is a tautology. Tests should specify behavior the implementation must exhibit, with enough independence from the implementation that the test would still make sense if the implementation were rewritten differently.

We use a test-driven approach where it makes sense, particularly for strategies. The strategy is the most algorithmically interesting part of the system, and writing tests first forces clear thinking about the desired behavior. For more mechanical code, tests can be written after the implementation, but they should still be written.

Tests run on every commit and every pull request. A change that breaks tests is not merged until either the change is fixed or the test is appropriately updated. This is the discipline that keeps the test suite useful over time.

---

## Principle Ten: Documentation Is Part Of The Code

This is also an addition, because while you mentioned wanting good documentation, the operational practices of how documentation is maintained deserve their own treatment.

Code without documentation is incomplete. Every module has a documentation comment at the top explaining what it does, what it depends on, what events it subscribes to and publishes, and what its failure modes are. Every type has documentation explaining what it represents and what invariants it maintains. Every public function has documentation explaining its parameters, its return value, and any error cases. This documentation is reviewed alongside the code and kept current when the code changes.

The documentation lives next to the code, not in a separate wiki or external system that drifts out of sync. Markdown comments above declarations are the standard. The architecture document, the engineering standards, and the architecture decision records are the only documentation that lives outside the code, and they cover system-level concerns rather than specific implementation details.

When something is not obvious from the code, a comment explains it. The classic guidance is that comments should explain why, not what, because the what is visible in the code itself. A comment that just paraphrases the code is noise. A comment that explains the reasoning behind a non-obvious choice is valuable. A comment that warns about a subtle pitfall is essential.

The CLAUDE.md file at the project root is itself part of the documentation, providing orientation for AI assistants working on the project. It is kept current as the project evolves, reflecting the current state of the system rather than a snapshot from when it was first written.

When making a change, ask whether any documentation is now out of date. If it is, update it as part of the same change. Stale documentation is worse than missing documentation, because it actively misleads the reader. Keeping documentation current requires discipline, but the discipline pays off every time someone, including future you, picks up the project.

---

## Principle Eleven: Use The MCP Tools When They Help

Model Context Protocol servers extend the capabilities Claude Code has access to in your project. They are useful when there is a specific tool or data source that benefits from direct access rather than going through general-purpose code.

For our project, useful MCP servers might include one for direct access to our SQLite database during debugging, allowing Claude Code to query trade history without us writing custom scripts. Another useful one might be access to Helius documentation or Solana documentation as a knowledge source, so Claude Code can look up RPC method signatures or account layouts directly. We do not need these immediately, but the project structure should accommodate adding them when they would be useful.

When considering whether to add an MCP server, the test is whether it solves a real friction. If you find yourself repeatedly asking Claude Code to look up the same information, an MCP server that provides that information directly is justified. If you find yourself writing the same kind of debug query over and over, an MCP server that exposes that query interface is justified. If neither friction exists yet, do not preemptively add MCP infrastructure.

When MCP servers are added, they are documented in the project alongside any other infrastructure choices. The CLAUDE.md file should mention them so future sessions know they are available.

---

## Putting The Principles Together

The eleven principles above are not independent. They reinforce each other. Treating errors as values supports security by ensuring failures cannot silently propagate. Modern TypeScript practices support testing by making code easier to mock and verify. Good documentation supports questioning assumptions because the assumptions are written down where they can be examined.

When making any decision about how to write a piece of code, consider all the relevant principles together. A solution that satisfies several principles at once is generally better than one that satisfies a single principle at the cost of others. When principles seem to conflict, the conflict usually reveals that the design is not yet right, and the resolution is often to step back and rethink rather than to compromise on one principle to satisfy another.

The principles are also a tool for review. When reading code, whether code you wrote yourself or code an AI assistant generated, ask whether each principle is satisfied. If any principle is violated, ask whether the violation is justified or whether it represents an opportunity to improve the code.

Finally, the principles are living. As we work on the project, we will discover additional practices that deserve to be principles, and we will discover that some of the current principles need refinement. Update this document when that happens. The goal is a document that accurately reflects how we want to write code, not a document that froze at some point in the past.

---

## A Note On Tooling

The principles above are about practices, not tools, but a few tooling choices follow naturally from the principles. We will commit to specific tooling decisions in the project setup guide, but the standards document specifies the qualities we look for in our tools.

We use a build setup that catches type errors at compile time rather than only at runtime. We use a test runner that supports modern testing patterns and runs quickly enough that tests are run frequently. We use a linter that enforces our style choices automatically rather than relying on human review for stylistic consistency. We use a formatter that produces consistent output without us thinking about it. We use a package manager that produces reproducible builds. These choices reduce friction and let us focus attention on the parts of the code that actually matter.

When evaluating new tooling, the question is whether it makes our principles easier to follow or whether it adds friction. If a tool makes good practices easier, adopt it. If a tool requires extensive configuration just to do basic things, look for alternatives.

---

## Closing Note

These standards exist to make the code better and the work more pleasant. They are not bureaucracy. Each one is here because it solves a real problem that real engineers have hit in real codebases. When applying them feels like a chore, the answer is usually that you have not yet internalized why the principle matters. Take a moment to think about what would happen without the principle, and the chore feeling typically goes away.

When applying them feels obviously wrong in a specific case, examine the case carefully. There may be a real conflict that the principles do not yet address, in which case the document should be updated to handle the new case. There may be a misunderstanding of the principle, in which case the principle's wording should be clarified. There may be a genuine exception, in which case the exception should be documented so future readers know it is intentional rather than a mistake.

The standards are a tool for thinking, not a substitute for thinking. Use them that way.
