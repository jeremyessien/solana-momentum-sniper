# Practical Guide

This document covers the practical steps to get from documentation to a working development environment. It assumes you have read the architecture document, the engineering standards, the existing ADRs, and the CLAUDE.md file. If those are unfamiliar, read them first because this guide builds on the foundations they establish.

The guide is organized in the order you will encounter the steps. Setting up your local environment, configuring Telegram, organizing the project on disk, starting Claude Code, and the working patterns for productive sessions. Each section is focused on what you actually need to do rather than on theory.

## Setting Up Your Local Development Environment

Your Mac already has most of what you need for Node.js development. The few things you need to install are straightforward, but I want to be deliberate about the choices because they affect everything else.

You need Node.js itself, ideally a recent LTS version. The recommended way to install Node.js on a Mac is through a version manager called nvm or the newer alternative called fnm. Version managers let you switch between Node.js versions without conflicts, which matters when you eventually have multiple projects with different requirements. Installing Node.js directly through the official installer works for one project but limits your flexibility later. Pick a version manager and use it.

You need a package manager for Node.js. The default is npm, which comes with Node.js. The alternatives are pnpm and yarn. For this project I recommend pnpm because it produces faster installs, uses less disk space, and has stricter dependency resolution that catches some classes of bugs npm misses. The choice is not load-bearing, so if you have a strong preference for something else, that is fine.

You need a code editor. Cursor is my recommendation if you are already using it, but VS Code with the appropriate extensions is also excellent. The choice matters less than the configuration. The editor should have TypeScript support, a Git integration, and the ability to run a terminal alongside the code view. All major editors meet these requirements.

You need Git. macOS includes Git through the developer tools, which install automatically the first time you run a Git command. If Git is not yet installed, simply running git in the terminal will trigger the installation prompt.

You need Claude Code itself. The installation instructions are on Anthropic's documentation site, and they evolve as Claude Code is updated. Following the official installation guide is more reliable than following any specific commands I might write here. Once installed, you can verify it works by running it in a project folder.

The last setup item is a Solana wallet client for generating the keypair the bot will use. The Solana CLI is the standard tool for this, and it can be installed through the official Solana installer. The CLI has many capabilities, but for our purposes you need it for keypair generation. The wallet adapter ADR explains why we generate the key locally rather than on the deployment server, and the CLI is what does the local generation.

When all of these are installed, your machine is ready for development work. You do not need to install Node.js packages globally. The packages your project needs will be installed locally to the project folder when we set it up.

## Setting Up Your Telegram Bot

The Telegram bot is the user interface for the trading bot, and you need to create it before any code can use it. The process happens entirely in the Telegram app and takes a few minutes.

Open Telegram and search for a contact called BotFather. The official BotFather has a verified checkmark, and you should make sure you are talking to the verified account because there are imitators. Start a conversation with BotFather and send the message /newbot. BotFather will ask you for a name for your bot, which is the display name humans see, and then for a username, which must end in bot and be globally unique on Telegram.

Once you complete the setup, BotFather sends you a message containing the bot token. The token is a long string that looks like a series of numbers and letters separated by colons. This token is what authenticates your bot to Telegram. Anyone with the token can impersonate your bot, send messages as it, and receive messages sent to it. Treat it with the same care you would treat a password to an important account.

Save the token immediately in a place where you will not lose it but where it is also not exposed. A password manager is ideal. A note on your phone is acceptable temporarily. Do not paste the token into any chat application, document service, or anywhere it might be backed up to a service that does not have appropriate protection. We will eventually move it to your .env file on the development machine, where it will be loaded by the bot at startup.

You also need your own Telegram user ID for the authentication whitelist. The user ID is a numeric identifier that is different from your username. To find it, search for a bot called userinfobot, send it any message, and it will respond with your user ID. Save this number alongside your bot token, because both will go into your .env file.

After the bot is created and you have the token and your user ID, send a message to your bot from your account. This is necessary because Telegram will not allow your bot to send you messages until you have initiated contact with it. The bot does not respond yet because it has no code, but the message creates the chat that the bot can later reply in.

That is the entire Telegram setup. Two pieces of information saved securely: the bot token and your user ID. We will use them when we configure the bot's runtime environment.

## Setting Up the Project Folder

Create the project folder on your Mac in whatever location you prefer for development projects. A common pattern is to have a Projects folder in your home directory and to put each project as a subfolder. The full path might be something like /Users/yourname/Projects/solana-momentum-sniper.

Inside the project folder, create the initial structure that the documentation expects. The CLAUDE.md file goes at the root. The docs folder goes at the root and contains the architecture document, the engineering standards, the practical guide you are reading, and the adr subfolder containing the architecture decision records. Drop all the markdown documents we have produced into their correct locations.

After the documentation is in place, the folder is ready for Claude Code but does not yet contain any code. The code structure will be created when we begin implementation, following the seven-module organization described in the architecture document.

Initialize the folder as a Git repository by running git init in it from the terminal. This is important even before you have any code, because Git tracks changes from the moment of initialization, and you want the documentation phase to be part of the project history. After initialization, add a .gitignore file at the root that excludes node_modules, the .env file, and any other locally generated artifacts. The exact contents of .gitignore will evolve as the project grows, but starting with at least those exclusions prevents accidental commits of secrets or build artifacts.

If you plan to push the project to GitHub or another Git hosting service, do that early so you have remote backups of your work. The documentation alone is valuable enough to justify protecting it. When you eventually have code and an .env file, the .gitignore must be working correctly to prevent secrets from being pushed to the remote. Verify this by checking that the .env file does not appear in the output of git status before any push.

## Starting Claude Code

When the folder is set up, open a terminal and navigate to the project folder. Start Claude Code in that folder using whatever command the current Claude Code installation uses. Claude Code reads the CLAUDE.md file at the root and the documentation in the docs folder as part of establishing context for the session.

The first session in a new project benefits from a deliberate opening. Rather than immediately asking Claude Code to write code, take a few exchanges to verify that Claude Code understands the project. Ask Claude Code to summarize what the project is, what the architecture looks like, and what the working style expectations are. The summary should match what is in the documentation. If it does not match, that indicates either an issue with how Claude Code read the documents or a gap in the documentation itself.

For your first real implementation task, start small. The architecture document describes eight modules, and you do not have to build them all at once. The first module to build is usually one of the foundational pieces in the infrastructure layer, such as the configuration loader or the event bus implementation. These are foundational because everything else depends on them, but they are also relatively simple compared to the later modules. They are good starting points for learning the patterns of the codebase.

When working with Claude Code, lean into the dialogue rather than requesting complete implementations. Ask for explanations before code is written. Ask follow-up questions when something is unclear. Stop and discuss when you encounter a concept you do not understand. This is the working pattern the CLAUDE.md file establishes, and it is also how you will actually learn the stack rather than just having code that works.

When Claude Code makes a significant decision, ask it to record the decision as an ADR if the decision warrants one. Not every decision needs an ADR, but the threshold should be lower rather than higher in the early phases when patterns are being established. ADRs accumulate to form the authoritative record of how the system evolved, and missing an early ADR is harder to fix than writing one preemptively.

## Working Patterns Across Sessions

Claude Code sessions are not continuous. Each session is isolated from the previous one. The documentation is what bridges sessions, which is why we have invested so much effort in producing comprehensive documents. When you start a new session, Claude Code reads the documentation to establish context.

This means the documentation must be kept current as the project evolves. When code is written that affects the architecture, the architecture document is updated. When new decisions are made, new ADRs are written. When patterns emerge that should be standardized, the engineering standards are updated. The discipline of keeping documentation current is what makes the system maintainable across sessions and over time.

Between Claude Code sessions, you may want to come back to a conversation interface like the one we have used here for higher-level discussions. The conversation interface is better suited to architectural discussions, design conversations, and reflection on what has been built. Claude Code is better suited to active code generation and modification. Using both has its place, and the documentation is what allows both interfaces to share understanding of the project.

When transitioning back to a conversation interface, attach the documentation files just as you attached the original specification at the start of our work. The conversation interface starts fresh each time, and the documentation establishes the same context that Claude Code reads from disk. The architecture document and the engineering standards together are usually sufficient for orientation. Specific ADRs can be attached when discussions touch their topics.

## Common Issues and Their Solutions

Some issues recur frequently when working with documentation-heavy projects. Knowing them in advance helps you address them quickly when they arise.

Documentation drift happens when code is changed without corresponding documentation updates. The result is documentation that misleads rather than guides, which is worse than no documentation. The defense is to treat documentation updates as part of the change rather than as a separate task. When you make a change to architecture, update the architecture document in the same commit. When you make a decision worth recording, write the ADR in the same session. The discipline is hard to maintain at first and becomes easier as the habit forms.

Generated code that does not match the standards is a frequent issue with AI assistants because their training pulls from a large pool of code that does not all share your standards. When generated code uses patterns that the engineering standards reject, the response is not to accept the code or to argue with the assistant about why it is wrong. The response is to point at the relevant section of the engineering standards and ask the assistant to revise. Doing this consistently teaches the assistant what to produce in your context, and the documentation becomes more useful through the feedback.

Lost context across sessions feels like the project is starting over each time. This is partly inherent to how AI assistants work, but it is also a signal that documentation is incomplete. If you find yourself explaining the same things repeatedly across sessions, those things should probably be in the documentation. Add them when you notice the pattern, and future sessions become more efficient.

Overconfidence from the assistant happens when the assistant produces something that looks correct but is actually wrong. The defense is to verify rather than trust. Run the code. Read the code. Test the code. When something does not work as expected, the assistant may have made a mistake even if the explanation sounds reasonable. Treating verification as part of the workflow rather than as paranoia produces better outcomes.

Underconfidence from yourself happens when you defer to the assistant on decisions that should be yours. The assistant is a tool, not an authority. You make the architectural decisions, the design tradeoffs, and the priority calls. The assistant explains options and implements your choices. When the assistant offers an opinion on something that is genuinely your call to make, the answer is to take the opinion as input but make the decision yourself.

## What Comes Next

After you have the development environment set up, the Telegram bot configured, the project folder organized, and Claude Code ready to use, the next step is your first real implementation work. Start by asking Claude Code to walk you through the architecture document, then to suggest where to begin. The first module is usually a foundation piece in the infrastructure layer that other modules will depend on.

The early implementation work is also where the deferred ADRs will be written. When you encounter a topic that needs a security ADR, write the ADR before implementing the code. When you encounter a topic that needs a new architectural decision, write the ADR. The documentation is alive, and it grows as the project grows.

Phase 1 of the rollout plan is observation only, which means the bot detects and analyzes tokens but does not trade. This phase is the safest place to learn the stack and validate the filter logic before any real money is at risk. Take phase 1 seriously and do not rush through it. Several weeks of observation produces the data you need to know whether the strategies actually have edge before you commit funds to them.

When you are ready, the documentation will be there to guide you. The architecture and standards do not change while you are away. The decisions are recorded. The reasoning is preserved. Pick up where you left off, and the project remembers itself.
